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
    const pct = promised > 0 ? Math.round((delivered / promised) * 100) : 0;
    let header = '⚠️ Gift ran short';
    if (shortfall >= promised * 0.5 && promised > 0) header = '🆘 Gift severely short';
    if (promised > 0 && delivered === 0) header = '💡 Pool empty — nothing to send';
    const who = [botUsername ? `@${botUsername}` : '', userId ? `user ${userId}` : ''].filter(Boolean).join(' · ');
    const text = [
      header + (who ? `  (${who})` : ''),
      `Asked for ${promised} but only ${delivered} sent (${pct}%). ${shortfall} missing.`,
      `Upload more media to the file channel so we can fill gifts next time.`,
    ].join('\n');
    for (const adminId of adminIds) {
      try {
        await telegram.sendMessage(adminId, text).catch(() => {});
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
  const traceLines = [];
  const chatOrUser = Number(chatId) ?? Number(userId);
  traceLines.push(`[dWV enter] promised=${promised} chat/user=${chatOrUser} receivedMedia=${Array.isArray(userRecord?.receivedMedia) ? userRecord.receivedMedia.length : '0/null'}`);

  while (attempts < MAX_TOTAL_DELIVERY_ATTEMPTS && actualCount < promised) {
    attempts += 1;
    const needed = Math.max(0, promised - actualCount);
    const baseExclude = Array.isArray(userRecord?.receivedMedia) ? userRecord.receivedMedia.slice().concat(rememberList) : rememberList.slice();
    traceLines.push(`[dWV round=${attempts}] needed=${needed} excludeIds.length=${baseExclude.length} rememberList=${rememberList.length}`);
    let items = [];
    try {
      // #region debug-point H5:dWV-round-start
      (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H5',location:'mediaSendObserver.js:dwv-round-start',msg:'[DEBUG] dWV round starting deliverMediaFn',data:{attempts,needed,baseExcludeLen:baseExclude.length,promised,actualCount},ts:Date.now()})}).catch(()=>{})})();
      // #endregion
      items = await Promise.race([
        (async () => {
          const v = await deliverMediaFn(telegram, chatOrUser, needed, {
            excludeIds: baseExclude,
          });
          return Array.isArray(v) ? v : [];
        })(),
        new Promise((_res, reject) => setTimeout(() => {
          reject(new Error('[deliverWithVerification] deliverMediaFn stalled > 7min'));
        }, 7 * 60 * 1000)),
      ]);
    } catch (deliveryErr) {
      console.error('[deliverWithVerification] deliverMediaFn threw/stalled:', deliveryErr.message);
      traceLines.push(`[dWV round=${attempts}] deliverMediaFn throw=${String(deliveryErr.message).slice(0, 120)}`);
      // #region debug-point H5:dWV-round-throw
      (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H5',location:'mediaSendObserver.js:dwv-round-throw',msg:'[DEBUG] dWV round deliverMediaFn throw',data:{attempts,err:String(deliveryErr.message||deliveryErr).slice(0,200),stack:(deliveryErr.stack||'').slice(0,220)},ts:Date.now()})}).catch(()=>{})})();
      // #endregion
      lastReturnedCount = 0;
      break;
    }
    const returnedThisRound = Array.isArray(items) ? items.length : 0;
    lastReturnedCount = returnedThisRound;
    actualCount += returnedThisRound;
    const anyChanged = rememberInline(items);
    traceLines.push(`[dWV round=${attempts}] returned=${returnedThisRound} anyChanged=${anyChanged ? 1 : 0} actualAfter=${actualCount} rememberList=${rememberList.length}`);
    // #region debug-point H5:dWV-round-result
    (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H5',location:'mediaSendObserver.js:dwv-round-result',msg:'[DEBUG] dWV round deliverMediaFn returned',data:{attempts,returnedThisRound,actualCount,anyChanged,rememberListLen:rememberList.length,promised},ts:Date.now()})}).catch(()=>{})})();
    // #endregion
    if (typeof onNewBatchDelivered === 'function') {
      try { await Promise.resolve(onNewBatchDelivered(items)); } catch (_e) { /* swallow */ }
    }
    if (!anyChanged && typeof rememberDeliveredMediaFn === 'function' && userRecord) {
      try { rememberDeliveredMediaFn(userRecord, items); } catch (_e) { /* swallow */ }
    }
    if (actualCount >= promised) { traceLines.push(`[dWV exit] actual >= promised (round=${attempts})`); break; }
    if (returnedThisRound === 0) { traceLines.push(`[dWV exit] zero returned round=${attempts}`); break; }
  }

  if (actualCount > promised) actualCount = promised;

  const shortfall = Math.max(0, promised - actualCount);
  traceLines.push(`[dWV final] promised=${promised} actual=${actualCount} shortfall=${shortfall} attempts=${attempts}`);
  console.log(traceLines.join('\n'));
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
