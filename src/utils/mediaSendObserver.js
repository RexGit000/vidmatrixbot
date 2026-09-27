const SLEEP_MS_AFTER_DELIVERY = 3500;
const MAX_TOPUP_ROUNDS = 2;
const MAX_TOTAL_DELIVERY_ATTEMPTS = MAX_TOPUP_ROUNDS + 1;

const _observers = new Map();
const _originals = new Map();
const _wrapped = new WeakSet();

function mediaSendObserverIsArmed(chatId) {
  return chatId != null && _observers.has(String(chatId));
}

function _ensureTelegramWrapped(telegram) {
  if (!telegram || _wrapped.has(telegram)) return;
  const methodNames = ['sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio', 'sendAnimation'];
  for (const methodName of methodNames) {
    const original = telegram[methodName];
    if (typeof original !== 'function') continue;
    if (!_originals.has(telegram)) _originals.set(telegram, new Map());
    _originals.get(telegram).set(methodName, original);
    const counterKey = methodName.replace(/^send/, '').toLowerCase();
    telegram[methodName] = async function wrappedMediaSend(...args) {
      const res = await original.apply(this, args);
      try {
        let chatId = args[0];
        if (chatId && typeof chatId === 'object' && chatId != null && 'chat_id' in chatId) {
          chatId = chatId.chat_id;
        }
        if (chatId != null && res && res.message_id != null) {
          const obs = _observers.get(String(chatId));
          if (obs) {
            obs[counterKey] = (obs[counterKey] || 0) + 1;
            obs.total = (obs.total || 0) + 1;
          }
        }
      } catch (_e) { /* swallow */ }
      return res;
    };
  }
  _wrapped.add(telegram);
}

function armMediaSendObserver(telegram, chatId) {
  if (chatId == null) return null;
  _ensureTelegramWrapped(telegram);
  const key = String(chatId);
  const existing = _observers.get(key);
  if (existing) {
    existing.startedAt = Date.now();
    existing.photo = 0;
    existing.video = 0;
    existing.document = 0;
    existing.audio = 0;
    existing.animation = 0;
    existing.total = 0;
    return existing;
  }
  const obs = {
    startedAt: Date.now(),
    photo: 0,
    video: 0,
    document: 0,
    audio: 0,
    animation: 0,
    total: 0,
  };
  _observers.set(key, obs);
  return obs;
}

function disarmAndCountMediaSendObserver(chatId) {
  if (chatId == null) return null;
  const key = String(chatId);
  const obs = _observers.get(key);
  if (!obs) {
    return { startedAt: null, photo: 0, video: 0, document: 0, audio: 0, animation: 0, total: 0 };
  }
  _observers.delete(key);
  return obs;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function alertChronicShortfall(telegram, adminIdsOrGetAdminIds, {
  botUsername,
  userId,
  orderId,
  promised,
  delivered,
  shortfall,
}) {
  try {
    let adminIds = [];
    if (Array.isArray(adminIdsOrGetAdminIds)) {
      adminIds = adminIdsOrGetAdminIds.map(Number).filter((n) => Number.isFinite(n));
    } else if (typeof adminIdsOrGetAdminIds === 'function') {
      const res = await Promise.resolve(adminIdsOrGetAdminIds());
      adminIds = (Array.isArray(res) ? res : []).map(Number).filter((n) => Number.isFinite(n));
    }
    if (!adminIds.length) return;
    const text = `⚠️ [${botUsername || 'bot'}] Chronic media shortfall\n`
      + `user=${userId}\n`
      + `order=${orderId || 'n/a'}\n`
      + `promised=${promised}\n`
      + `delivered=${delivered}\n`
      + `shortfall=${shortfall}\n`
      + `after ${MAX_TOTAL_DELIVERY_ATTEMPTS} attempts. Please investigate.`;
    for (const adminId of adminIds) {
      try { await telegram.sendMessage(adminId, text).catch(() => {}); } catch (_e) { /* swallow */ }
    }
  } catch (_e) { /* swallow */ }
}

async function deliverWithVerification({
  telegram,
  chatId,
  userId,
  orderId,
  finalMediaCount,
  userRecord,
  deliverMediaFn,
  rememberDeliveredMediaFn,
  onNewBatchDelivered,
  adminIdResolver,
  botUsername,
}) {
  const promised = Number(finalMediaCount) || 0;
  let cumulativeReturned = 0;
  let cumulativeDeliveredIds = [];

  function combineExcludeIds() {
    const base = Array.isArray(userRecord?.receivedMedia) ? userRecord.receivedMedia.slice() : [];
    const set = new Set(base.map((id) => id.toString()));
    for (const id of cumulativeDeliveredIds) set.add(id.toString());
    return Array.from(set);
  }

  function addToCumulative(items) {
    if (!Array.isArray(items) || !items.length) return;
    cumulativeReturned += items.length;
    for (const it of items) {
      if (it && it._id != null) cumulativeDeliveredIds.push(it._id.toString());
    }
  }

  let lastReturnedCount = 0;
  let lastObservedCount = 0;
  let actualCount = 0;
  let attempts = 0;

  while (attempts < MAX_TOTAL_DELIVERY_ATTEMPTS && actualCount < promised) {
    attempts += 1;
    const needed = Math.max(0, promised - actualCount);
    armMediaSendObserver(telegram, chatId);
    const items = await deliverMediaFn(telegram, Number(userId), needed, {
      excludeIds: combineExcludeIds(),
    });
    const returnedThisRound = Array.isArray(items) ? items.length : 0;
    addToCumulative(items);
    if (typeof onNewBatchDelivered === 'function') {
      try { await Promise.resolve(onNewBatchDelivered(items)); } catch (_e) { /* swallow */ }
    }
    await sleep(SLEEP_MS_AFTER_DELIVERY);
    const observed = disarmAndCountMediaSendObserver(chatId);
    const observedCount = observed ? observed.total || 0 : 0;
    lastReturnedCount = returnedThisRound;
    lastObservedCount = observedCount;
    actualCount = Math.max(actualCount + lastReturnedCount, actualCount + lastObservedCount);
    if (actualCount >= promised) break;
    if (lastReturnedCount === 0 && lastObservedCount === 0) break;
  }

  if (actualCount > promised) actualCount = promised;

  const shortfall = Math.max(0, promised - actualCount);
  if (shortfall > 0) {
    await alertChronicShortfall(telegram, adminIdResolver, {
      botUsername,
      userId,
      orderId,
      promised,
      delivered: actualCount,
      shortfall,
    });
  }

  let rememberChanged = false;
  if (typeof rememberDeliveredMediaFn === 'function' && userRecord && cumulativeDeliveredIds.length) {
    const pseudoItems = cumulativeDeliveredIds.map((id) => ({ _id: id }));
    rememberChanged = !!rememberDeliveredMediaFn(userRecord, pseudoItems);
  }

  return {
    promised,
    actualCount,
    shortfall,
    attempts,
    lastReturnedCount,
    lastObservedCount,
    cumulativeReturned,
    rememberChanged,
  };
}

module.exports = {
  SLEEP_MS_AFTER_DELIVERY,
  MAX_TOPUP_ROUNDS,
  MAX_TOTAL_DELIVERY_ATTEMPTS,
  armMediaSendObserver,
  disarmAndCountMediaSendObserver,
  mediaSendObserverIsArmed,
  deliverWithVerification,
  alertChronicShortfall,
};
