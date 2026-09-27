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
  const methodNames = ['sendPhoto', 'sendVideo', 'sendDocument', 'sendAudio', 'sendAnimation', 'copyMessage', 'forwardMessage'];
  for (const methodName of methodNames) {
    const original = telegram[methodName];
    if (typeof original !== 'function') continue;
    if (!_originals.has(telegram)) _originals.set(telegram, new Map());
    _originals.get(telegram).set(methodName, original);
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
            const counterKey = 'total';
            obs[counterKey] = (obs[counterKey] || 0) + 1;
            if (!Array.isArray(obs.messageIds)) obs.messageIds = [];
            obs.messageIds.push(res.message_id);
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
    existing.messageIds = [];
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
    messageIds: [],
  };
  _observers.set(key, obs);
  return obs;
}

function disarmAndCountMediaSendObserver(chatId) {
  if (chatId == null) return null;
  const key = String(chatId);
  const obs = _observers.get(key);
  if (!obs) {
    return { startedAt: null, photo: 0, video: 0, document: 0, audio: 0, animation: 0, total: 0, messageIds: [] };
  }
  _observers.delete(key);
  return {
    startedAt: obs.startedAt,
    photo: obs.photo || 0,
    video: obs.video || 0,
    document: obs.document || 0,
    audio: obs.audio || 0,
    animation: obs.animation || 0,
    total: obs.total || 0,
    messageIds: Array.isArray(obs.messageIds) ? obs.messageIds.slice() : [],
  };
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
    const shortfallPct = promised > 0 ? Math.round((shortfall / promised) * 100) : 0;
    const attempts = MAX_TOTAL_DELIVERY_ATTEMPTS;
    const attemptLine = attempts <= 1
      ? 'Tried once and still missed some.'
      : attempts === 2
      ? 'Tried a 2nd pass top-up and still missed some.'
      : `Tried ${attempts} times (1 initial + ${attempts - 1} top-up passes) and still missed some.`;
    const severity = shortfallPct >= 60 ? '🆘 SEVERE' : shortfallPct >= 30 ? '⚠️ WARNING' : '💡 NOTICE';
    const title = `${severity} ${botUsername || 'bot'} — delivery shortfall`;
    const text = `${title}\n`
      + `\n`
      + `👤 user: \`${userId}\`\n`
      + `📦 promised : ${promised}\n`
      + `✅ delivered: ${delivered}\n`
      + `❌ missing  : ${shortfall} (${shortfallPct}%)\n`
      + `\n`
      + `${attemptLine}\n`
      + `If missing keeps happening, check: stale bot_file_ids, bad Telegram routing, bot not in file channel, DB rows w/o source.message_id, or cluster-wide timeouts.`;
    for (const adminId of adminIds) {
      try {
        await telegram.sendMessage(adminId, text, { parse_mode: 'Markdown' }).catch(() => {});
      } catch (_e) { /* swallow */ }
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

  let rememberList = [];
  function rememberInline(batchItems) {
    if (!Array.isArray(batchItems) || !batchItems.length) return false;
    let changed = false;
    for (const it of batchItems) {
      if (!it || it._id == null) continue;
      const k = String(it._id);
      if (rememberList.includes(k)) continue;
      rememberList.push(k);
      changed = true;
    }
    return changed;
  }

  let lastReturnedCount = 0;
  let actualCount = 0;
  let attempts = 0;

  while (attempts < MAX_TOTAL_DELIVERY_ATTEMPTS && actualCount < promised) {
    attempts += 1;
    const needed = Math.max(0, promised - actualCount);
    let items = [];
    try {
      items = await Promise.race([
        (async () => {
          const v = await deliverMediaFn(telegram, Number(chatId) ?? Number(userId), needed, {
            excludeIds: Array.isArray(userRecord?.receivedMedia) ? userRecord.receivedMedia.slice().concat(rememberList) : rememberList.slice(),
          });
          return Array.isArray(v) ? v : [];
        })(),
        new Promise((_res, reject) => setTimeout(() => {
          reject(new Error('[deliverWithVerification] deliverMediaFn stalled > 7min'));
        }, 7 * 60 * 1000)),
      ]);
    } catch (deliveryErr) {
      console.error('[deliverWithVerification] deliverMediaFn threw/stalled:', deliveryErr.message);
      lastReturnedCount = 0;
      break;
    }
    const returnedThisRound = Array.isArray(items) ? items.length : 0;
    lastReturnedCount = returnedThisRound;
    actualCount += returnedThisRound;
    const anyChanged = rememberInline(items);
    if (typeof onNewBatchDelivered === 'function') {
      try { await Promise.resolve(onNewBatchDelivered(items)); } catch (_e) { /* swallow */ }
    }
    if (!anyChanged && typeof rememberDeliveredMediaFn === 'function' && userRecord) {
      try { rememberDeliveredMediaFn(userRecord, items); } catch (_e) { /* swallow */ }
    }
    if (actualCount >= promised) break;
    if (returnedThisRound === 0) break;
  }

  if (actualCount > promised) actualCount = promised;

  const shortfall = Math.max(0, promised - actualCount);
  if (shortfall > 0) {
    try {
      await alertChronicShortfall(telegram, adminIdResolver, {
        botUsername,
        userId,
        orderId,
        promised,
        delivered: actualCount,
        shortfall,
      });
    } catch (_e) { /* swallow */ }
  }

  let rememberChanged = false;
  if (typeof rememberDeliveredMediaFn === 'function' && userRecord && rememberList.length) {
    const pseudoItems = rememberList.map((id) => ({ _id: id }));
    rememberChanged = !!rememberDeliveredMediaFn(userRecord, pseudoItems);
  }

  return {
    promised,
    actualCount,
    shortfall,
    attempts,
    lastReturnedCount,
    lastObservedCount: lastReturnedCount,
    cumulativeReturned: actualCount,
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
