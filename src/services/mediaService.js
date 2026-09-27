const { LRUCache } = require('lru-cache');
const Media = require('../models/Media');
const UserbotAccount = require('../models/UserbotAccount');
const Settings = require('../models/Settings');
const { deliveryCache } = require('../cache');
const { enqueueDeliver } = require('./queue');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');

const BOT_KEY = String(process.env.CURRENT_BOT_KEY || (process.env.BOT_TOKEN || '').split(':')[0] || 'default').trim();

const pendingPromiseCache = new LRUCache({ max: 1000, ttl: 60 * 1000 });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let _userbotClientSingleton = null;
let _userbotClientAccountId = null;
let _userbotClientInitLock = null;
async function getUserbotClient() {
  if (_userbotClientSingleton && _userbotClientAccountId) {
    return _userbotClientSingleton;
  }
  if (_userbotClientInitLock) return _userbotClientInitLock;
  _userbotClientInitLock = (async () => {
    const row = await UserbotAccount.findOne({ session: { $ne: null, $exists: true } })
      .select('_id session api_id api_hash')
      .sort({ updatedAt: -1 })
      .limit(1)
      .lean();
    if (!row || !row.session) return null;
    const apiId = Number(row.api_id || process.env.API_ID || 0) || null;
    const apiHash = String(row.api_hash || process.env.API_HASH || '').trim() || null;
    if (!apiId || !apiHash) {
      console.warn('[userbot] saved session exists but API_ID/API_HASH not set — userbot direct fallback unavailable.');
      return null;
    }
    let client = new TelegramClient(new StringSession(row.session), apiId, apiHash, {
      useWSS: true,
      autoReconnect: true,
      timeout: 20000,
      requestRetries: 1,
      connectionRetries: 2,
      retryDelay: 1000,
    });
    client.setLogLevel?.('none');
    try { if (typeof client.on === 'function') {
      client.on('error', (e) => {
        const msg = String(e?.message || e || '').toLowerCase();
        if (msg.includes('channels.getchannels') || msg.includes('channel_invalid') || msg.includes('flood')) return;
        console.warn('[userbot client event err]:', String(e?.message || e || '').slice(0, 200));
      });
      client._oldCatchUnhandled = true;
    } } catch (_) {}
    try { await client.connect({ timeout: 30000 }); } catch (e) {
      console.warn('[userbot] connect failed:', e.message);
      try { await client.destroy?.()?.catch?.(() => {}); } catch (_) {}
      return null;
    }
    try {
      const me = await client.getMe({ timeout: 15000 }).catch(() => null);
      if (!me) {
        console.warn('[userbot] client connected but getMe failed — session likely stale.');
        try { await client.destroy?.()?.catch?.(() => {}); } catch (_) {}
        return null;
      }
    } catch (e) {
      console.warn('[userbot] getMe failed:', e.message);
      try { await client.destroy?.()?.catch?.(() => {}); } catch (_) {}
      return null;
    }
    _userbotClientSingleton = client;
    _userbotClientAccountId = String(row._id);
    return client;
  })();
  try {
    const c = await _userbotClientInitLock;
    return c;
  } finally {
    _userbotClientInitLock = null;
  }
}

function normalizeSourceChannelIdToUserbot(channelIdAny) {
  if (channelIdAny == null || channelIdAny === '') return null;
  const s = String(channelIdAny).trim();
  const digits = s.replace(/^-100/, '').replace(/^-/, '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const asBigInt = BigInt(digits);
  if (s.startsWith('-100') || BigInt.asIntN(64, asBigInt) < 0n) {
    return Number('-100' + digits);
  }
  const asNum = Number(digits);
  if (asNum < 0) return asNum;
  return Number('-100' + digits);
}

async function getUserbotEntitySafe(userbotClient, channelIdAny, chatIdAny) {
  if (!userbotClient || !channelIdAny) return null;
  let tryList = [];
  const neg = normalizeSourceChannelIdToUserbot(channelIdAny);
  if (neg) tryList.push(neg);
  if (String(channelIdAny).trim() !== String(neg ?? '')) tryList.push(String(channelIdAny).trim());
  if (chatIdAny) {
    const tchat = String(chatIdAny).trim();
    if (!tryList.includes(tchat)) tryList.push(tchat);
  }
  let lastErr = null;
  for (const candidate of tryList) {
    for (const fn of [
      (c) => userbotClient.getEntity(c),
      (c) => userbotClient.getInputEntity(c),
      (c) => userbotClient.getPeerId(c),
    ]) {
      try {
        const out = await Promise.race([
          Promise.resolve(fn(candidate)),
          new Promise((_res, rej) => setTimeout(() => rej(new Error('getEntity_timeout')), 8000)),
        ]);
        if (out) return { entity: out, raw: candidate };
      } catch (e) { lastErr = e; }
    }
  }
  if (lastErr) console.warn('[userbot] getUserbotEntitySafe last error:', String(lastErr.message || lastErr).slice(0, 180), 'src=', channelIdAny);
  return null;
}

async function uploadFileViaUserbot(userbotClient, row, chatId) {
  if (!row || !row.source || !row.source.channel_id || !row.source.message_id) return null;
  let fromEntity = null;
  let toEntity = null;
  try {
    const e1 = await getUserbotEntitySafe(userbotClient, row.source.channel_id, chatId);
    if (!e1) return null;
    fromEntity = e1.entity;
  } catch (e) {
    console.warn('[userbot] source resolve err:', String(e.message || e).slice(0, 180));
    return null;
  }
  try {
    const e2 = await getUserbotEntitySafe(userbotClient, chatId, null);
    if (!e2) return null;
    toEntity = e2.entity;
  } catch (e) {
    console.warn('[userbot] target resolve err:', String(e.message || e).slice(0, 180));
    return null;
  }
  try {
    const msgId = Number(row.source.message_id);
    let fetchedMsg = null;
    const fetchAttempts = [
      async () => { const m = await userbotClient.getMessages(fromEntity, { ids: [msgId], limit: 1 }); return m && m.length ? m[0] : null; },
      async () => {
        const iter = await userbotClient.getHistory(fromEntity, { limit: 10 });
        const arr = Array.isArray(iter) ? iter : (iter && Array.isArray(iter.messages) ? iter.messages : null);
        if (!arr) return null;
        return arr.find(m => Number(m.id) === msgId) || null;
      },
    ];
    for (const fn of fetchAttempts) {
      try {
        const got = await fn();
        if (got) { fetchedMsg = got; break; }
      } catch (e) {}
    }
    if (!fetchedMsg) return null;
    const media = fetchedMsg.media || null;
    if (!media) return null;
    const cap = fetchedMsg.message || '';
    const sendAttempts = [
      async () => {
        const res = await userbotClient.invoke(new Api.messages.SendMedia({
          peer: toEntity,
          media: media,
          message: cap,
          randomId: Math.floor(Math.random() * 1e18),
        }), { timeout: 60000 });
        if (res && res.id) return { ok: true, via: 'userbot_sendMedia', messageId: Number(res.id) };
        return null;
      },
      async () => {
        const res = await userbotClient.sendFile(toEntity, {
          file: media,
          caption: cap,
          workers: 1,
          progressCallback: undefined,
        });
        if (res && res.id) return { ok: true, via: 'userbot_sendFile', messageId: Number(res.id) };
        return null;
      },
    ];
    for (const fn of sendAttempts) {
      try {
        const r = await fn();
        if (r && r.ok) return r;
      } catch (_e) {}
    }
    return null;
  } catch (e) {
    console.warn('[userbot] uploadFileViaUserbot top-level err:', String(e?.message || e || '').slice(0, 200));
    return null;
  }
}

function isTimeoutError(err) {
  if (!err) return false;
  const name = err?.name || '';
  const msg  = String(err?.message || err?.description || '').toLowerCase();
  if (name === 'TimeoutError') return true;
  if (msg.includes('promise timed out after')) return true;
  if (msg.includes('timeout')) return true;
  return false;
}

async function withRetry(fn, maxRetries = 4, hardDeadlineMs = 60_000) {
  const startedAt = Date.now();
  let retries = 0;
  while (retries < maxRetries) {
    const deadlineExceeded = hardDeadlineMs > 0 && (Date.now() - startedAt) >= hardDeadlineMs;
    if (deadlineExceeded) throw new Error(`[withRetry] deadline ${hardDeadlineMs}ms exceeded (retries=${retries})`);
    try {
      return await fn();
    } catch (err) {
      if (err && err.response && err.response.error_code === 429 && err.response.parameters && err.response.parameters.retry_after) {
        const retryAfter = Math.min(60_000, err.response.parameters.retry_after * 1000);
        if ((Date.now() - startedAt) + retryAfter > hardDeadlineMs && hardDeadlineMs > 0) {
          throw new Error(`[withRetry] 429 retry_after=${retryAfter} would exceed deadline; retries=${retries}; err=${String(err?.response?.description || err.message).slice(0, 120)}`);
        }
        await sleep(retryAfter);
        retries++;
        continue;
      }
      if (isTimeoutError(err)) {
        const backoff = Math.min(8000, 1500 * Math.pow(2, retries));
        if ((Date.now() - startedAt) + backoff > hardDeadlineMs && hardDeadlineMs > 0) {
          throw new Error(`[withRetry] timeout retry backoff=${backoff} would exceed deadline; retries=${retries}; err=${String(err.message).slice(0, 120)}`);
        }
        await sleep(backoff);
        retries++;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Max retries (${maxRetries}) exceeded`);
}

function isSkippableTelegramError(err) {
  const description = String(err?.description || err?.response?.description || err?.message || '').toLowerCase();
  return (
    description.includes('bot was blocked by the user') ||
    description.includes('user is deactivated') ||
    description.includes('chat not found') ||
    description.includes('forbidden: bot was blocked') ||
    description.includes('have no rights to send a message')
  );
}

function isBadFileIdentifierError(err) {
  const desc = String(err?.description || err?.response?.description || err?.message || '').toLowerCase();
  const code = Number(err?.error_code ?? err?.response?.error_code ?? 0);
  return (
    (code === 400 && (
      desc.includes('wrong file identifier') ||
      desc.includes('file_id is invalid') ||
      desc.includes('file not found')
    ))
  );
}

function unwrapQueueResult(v) {
  if (v instanceof Error) throw v;
  if (Array.isArray(v)) {
    const err = v.find((x) => x instanceof Error);
    if (err) throw err;
  }
  return v;
}

function summarizeErr(err) {
  if (!err) return '';
  return String(err?.message || err?.description || err?.response?.description || err).slice(0, 160);
}

async function hasActiveUserbot() {
  try {
    const c = await getUserbotClient();
    return !!c;
  } catch (err) {
    console.error('[delivery] hasActiveUserbot error:', err.message);
    return false;
  }
}

const HOT_SEND_HARD_TIMEOUT_MS = 45_000;
const COLD_COPY_HARD_TIMEOUT_MS = 60_000;

function withHardTimeout(promiseMs, label, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[delivery] ${label || 'task'} hard timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promiseMs).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function hotSendMedia(telegram, chatId, row, replyToMessageId) {
  try {
    const botKey = BOT_KEY;
    const fid = row && row.bot_file_ids ? row.bot_file_ids[botKey] : null;
    if (!fid) return { ok: false, reason: 'no_file_id' };

    const kind = row && row.metadata && typeof row.metadata.kind === 'string' ? row.metadata.kind.toLowerCase() : 'video';
    const baseExtra = {};
    if (replyToMessageId) baseExtra.reply_to_message_id = replyToMessageId;

    await withHardTimeout((async () => {
      unwrapQueueResult(await enqueueDeliver(async () => {
        await withRetry(async () => {
          if (kind === 'photo') {
            await telegram.sendPhoto(chatId, fid, baseExtra);
          } else if (kind === 'document') {
            const extra = { disable_content_type_detection: false, ...baseExtra };
            await telegram.sendDocument(chatId, fid, extra);
          } else {
            const extra = { supports_streaming: true, ...baseExtra };
            await telegram.sendVideo(chatId, fid, extra);
          }
        }, 4, HOT_SEND_HARD_TIMEOUT_MS);
      }));
    })(), `hot_send_${kind}_${chatId}`, HOT_SEND_HARD_TIMEOUT_MS + 5000);

    return { ok: true, via: `hot_send_${kind}` };
  } catch (err) {
    if (isTimeoutError(err) || (String(err.message || '').startsWith('[delivery] hot_send_') && err.message.includes('hard timeout'))) {
      return { ok: false, reason: 'hot_send_timeout', error: err, hardFail: false };
    }
    if (isSkippableTelegramError(err)) {
      return { ok: false, reason: 'chat_skippable', error: err, skippable: true };
    }
    if (isBadFileIdentifierError(err)) {
      try {
        if (row && row._id) {
          await Media.updateOne(
            { _id: row._id },
            { $unset: { [`bot_file_ids.${BOT_KEY}`]: 1 } }
          ).catch(() => {});
          deliveryCache.delete(String(row._id));
        }
      } catch (_) {}
      return { ok: false, reason: 'hot_send_failed_stale_slot', error: err, hardFail: false };
    }
    return { ok: false, reason: 'hot_send_failed', error: err };
  }
}

function copyForwardErrorLooksLikeDeadMessage(err) {
  if (!err) return false;
  const d = String(err?.description || err?.response?.description || err?.message || '').toLowerCase();
  if (!d) return false;
  return (
    d.includes('to copy not found') ||
    d.includes('message to forward not found') ||
    d.includes('message_id_invalid') ||
    d.includes('message not found') ||
    d.includes('channel_private') ||
    (d.includes('bad request') && (d.includes('message') && d.includes('not found')))
  );
}

async function lazyDeleteIfDead(row, err) {
  if (!row || !row._id) return false;
  if (!copyForwardErrorLooksLikeDeadMessage(err)) return false;
  try {
    await Media.deleteOne({ _id: row._id });
    try {
      deliveryCache.delete(String(row._id));
      const n = Number(row.caption_number);
      if (Number.isFinite(n)) pendingPromiseCache.delete(`vid:${n}`);
    } catch (_e) { /* ignore */ }
    return true;
  } catch (dbErr) {
    console.error('[delivery] lazy delete error:', dbErr.message);
    return false;
  }
}

function extractFileIdFromSentMessage(msg) {
  if (!msg) return null;
  if (msg.video && msg.video.file_id) return msg.video.file_id;
  if (msg.document && msg.document.file_id) return msg.document.file_id;
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    return msg.photo[msg.photo.length - 1].file_id;
  }
  return null;
}

async function coldForwardAndSeed(telegram, chatId, row, replyToMessageId, fileManagerChannelId) {
  try {
    if (!row || !row.source || !row.source.channel_id || !row.source.message_id) {
      return { ok: false, reason: 'missing_source' };
    }
    if (fileManagerChannelId != null && String(row.source.channel_id) !== String(fileManagerChannelId)) {
      return { ok: false, reason: 'channel_unapproved' };
    }
    const extra = replyToMessageId
      ? { reply_to_message_id: replyToMessageId, disable_notification: true }
      : { disable_notification: true };

    let lastError = null;
    let msg = null;
    try {
      await withHardTimeout((async () => {
        unwrapQueueResult(await enqueueDeliver(async () => {
          await withRetry(async () => {
            msg = await telegram.copyMessage(chatId, row.source.channel_id, row.source.message_id, extra);
          }, 3, COLD_COPY_HARD_TIMEOUT_MS);
        }));
      })(), `cold_copy_${row.source.channel_id}_${row.source.message_id}_${chatId}`, COLD_COPY_HARD_TIMEOUT_MS + 8000);
    } catch (forwardErr) {
      lastError = forwardErr;
      if (isSkippableTelegramError(forwardErr)) {
        return { ok: false, reason: 'chat_skippable', error: forwardErr, skippable: true };
      }
      if (isTimeoutError(forwardErr) || (String(forwardErr.message || '').startsWith('[delivery] cold_copy_') && forwardErr.message.includes('hard timeout'))) {
        return { ok: false, reason: 'cold_copy_timeout', error: forwardErr, hardFail: false };
      }
      try {
        await withHardTimeout((async () => {
          unwrapQueueResult(await enqueueDeliver(async () => {
            await withRetry(async () => {
              msg = await telegram.forwardMessage(chatId, row.source.channel_id, row.source.message_id, extra);
            }, 3, COLD_COPY_HARD_TIMEOUT_MS);
          }));
        })(), `cold_forward_${row.source.channel_id}_${row.source.message_id}_${chatId}`, COLD_COPY_HARD_TIMEOUT_MS + 8000);
      } catch (err) {
        lastError = err;
        msg = null;
        if (isTimeoutError(err) || (String(err.message || '').startsWith('[delivery] cold_forward_') && err.message.includes('hard timeout'))) {
          return { ok: false, reason: 'cold_forward_timeout', error: err, hardFail: false };
        }
      }
    }

    if (!msg) {
      if (lastError) {
        if (isSkippableTelegramError(lastError)) {
          return { ok: false, reason: 'chat_skippable', error: lastError, skippable: true };
        }
        try { await lazyDeleteIfDead(row, lastError); } catch (_e) { /* ignore */ }
      }
      return { ok: false, reason: 'copy_or_forward_failed', error: lastError };
    }

    const extracted = extractFileIdFromSentMessage(msg);
    if (extracted) {
      try {
        const botKey = BOT_KEY;
        const updated = await Media.findOneAndUpdate(
          { _id: row._id },
          { $set: { [`bot_file_ids.${botKey}`]: extracted, last_seen_at: new Date() } },
          { new: true }
        ).lean();
        if (updated) deliveryCache.set(String(updated._id), updated);
      } catch (err) {
        console.error('[delivery] cold seed file_id error:', err.message);
      }
    }

    return { ok: true, via: 'cold_copy_forward', delivered: !!msg };
  } catch (err) {
    if (isTimeoutError(err) || (String(err.message || '').startsWith('[delivery] cold_') && err.message.includes('hard timeout'))) {
      return { ok: false, reason: 'cold_timeout', error: err, hardFail: false };
    }
    if (isSkippableTelegramError(err)) {
      return { ok: false, reason: 'chat_skippable', error: err, skippable: true };
    }
    console.error('[delivery] coldForwardAndSeed error:', err.message);
    return { ok: false, reason: 'cold_error', error: err };
  }
}

async function userbotDirectFallback(row, chatId, userbotClient) {
  const client = userbotClient || (await getUserbotClient().catch(() => null));
  if (!client) {
    return { ok: false, reason: 'no_userbot_client' };
  }
  try {
    const startedAt = Date.now();
    const res = await uploadFileViaUserbot(client, row, chatId);
    if (res && res.ok) {
      return { ok: true, via: res.via || 'userbot', messageId: res.messageId, elapsedMs: Date.now() - startedAt };
    }
    return { ok: false, reason: 'userbot_send_failed', hardFail: false };
  } catch (err) {
    console.error('[delivery] userbotDirectFallback error:', err.message);
    return { ok: false, reason: 'userbot_error', error: err, hardFail: false };
  }
}

async function deliverMedia(telegram, chatId, count, { excludeIds = [], onProgress } = {}) {
  const countNum = Number(count) || 0;
  const TARGET = Math.max(1, Math.floor(countNum));
  const delivered = [];
  const usedIds = new Set(excludeIds.map((id) => String(id)));
  let shouldAbortChat = false;
  let hardFailStreak = 0;
  let hardFailTotal = 0;
  const HARD_FAIL_ABORT_STREAK = 16;
  const HARD_FAIL_ABORT_TOTAL = 80;
  const PARALLEL_BATCH_SIZE = Number(process.env.DELIVERY_PARALLEL) || 12;
  const SAMPLING_MAX_MULT = 30;
  const SAMPLING_MIN = 120;
  const onProgressFn = typeof onProgress === 'function' ? onProgress : null;
  const startedAt = Date.now();
  let tierCounts = { hot: 0, userbot: 0, cold: 0 };
  let tierElapsed = { hot: 0, userbot: 0, cold: 0 };

  let fileManagerChannelId = null;
  try { fileManagerChannelId = await Settings.get('fileManagerChannel'); } catch (_e) {}

  const userbotClient = await getUserbotClient().catch(() => null);
  const userbotAvailable = !!userbotClient;

  function emitProgress(eventName, payload) {
    if (!onProgressFn) return;
    try { onProgressFn(eventName, { ...(payload || {}), target: TARGET, delivered: delivered.length, elapsedMs: Date.now() - startedAt, tierCounts, tierElapsed }); } catch (_e) {}
  }

  emitProgress('begin');

  async function deliverOne(item, stopToken) {
    const itemId = item._id.toString();
    if (usedIds.has(itemId)) return { consumed: false, ok: false };
    usedIds.add(itemId);

    const t0 = Date.now();
    let sentOk = false;
    let skippableHit = false;
    let hardFailHit = false;
    let via = null;

    let lastHot = null;
    {
      const th = Date.now();
      const resHot = await hotSendMedia(telegram, chatId, item);
      lastHot = resHot;
      if (resHot && resHot.ok) {
        sentOk = true; via = 'hot';
        tierCounts.hot += 1; tierElapsed.hot += Date.now() - th;
      } else if (resHot && resHot.skippable) {
        skippableHit = true;
      } else if (resHot && resHot.hardFail === false) {
        hardFailHit = true;
      }
    }

    if (!sentOk && !skippableHit && userbotAvailable) {
      const tub = Date.now();
      const resUb = await userbotDirectFallback(item, chatId, userbotClient);
      if (resUb && resUb.ok) {
        sentOk = true; via = 'userbot'; hardFailHit = false;
        tierCounts.userbot += 1; tierElapsed.userbot += Date.now() - tub;
      } else if (resUb && resUb.skippable) {
        skippableHit = true; hardFailHit = false;
      } else if (resUb && resUb.hardFail === false) {
        // Only upgrade to hardFail when hot also explicitly said hardFail (or was unknown fallback)
        if (!hardFailHit && lastHot && lastHot.hardFail === false) hardFailHit = true;
      } else {
        // userbot failed but not a clear error (e.g. entity resolve, session stale): NOT a hardFail, don't count streak.
        if (hardFailHit && lastHot && lastHot.hardFail !== false) hardFailHit = false;
      }
    }

    if (!sentOk && !skippableHit) {
      const sourceOk = item && item.source &&
        item.source.channel_id && item.source.message_id != null && item.source.channel_id !== '';
      if (sourceOk) {
        const tc = Date.now();
        const resCold = await coldForwardAndSeed(telegram, chatId, item, null, fileManagerChannelId);
        if (resCold && resCold.ok) {
          sentOk = true; via = 'cold'; hardFailHit = false;
          tierCounts.cold += 1; tierElapsed.cold += Date.now() - tc;
        } else if (resCold && resCold.skippable) {
          skippableHit = true; hardFailHit = false;
        } else if (resCold && resCold.hardFail === false) {
          if (!hardFailHit && lastHot && lastHot.hardFail === false) hardFailHit = true;
        } else {
          // cold silently failed (not a "hardFail=false" response): do NOT force a streak bump if we only had one tier failing silently
          // unless hot also explicitly hardFailed
          if (!lastHot || lastHot.hardFail !== false) hardFailHit = false;
        }
      } else {
        // No source at all: if userbot wasn't available and hot returned !ok non-skippable → consider it a soft miss, not hardFail
        hardFailHit = false;
      }
    }

    if (skippableHit) {
      shouldAbortChat = true;
      return { consumed: true, ok: false, skippable: true };
    }
    if (sentOk) {
      hardFailStreak = 0;
      delivered.push(item);
      try {
        Media.updateOne({ _id: item._id }, { $set: { last_seen_at: new Date() } }).catch(() => {});
      } catch (_) {}
      emitProgress('batch', { itemId, via });
      return { consumed: true, ok: true, via };
    } else {
      if (hardFailHit) {
        hardFailStreak += 1;
        hardFailTotal += 1;
      }
      return { consumed: true, ok: false, hardFailHit };
    }
  }

  while (delivered.length < TARGET && !shouldAbortChat) {
    const filter = { _id: { $nin: Array.from(usedIds) } };
    const available = await Media.countDocuments(filter);
    if (available === 0) break;
    if (hardFailStreak >= HARD_FAIL_ABORT_STREAK) {
      console.error(`[delivery] bail after ${hardFailStreak} consecutive hard-fails streak; total fails=${hardFailTotal}; returning ${delivered.length}/${TARGET} chat=${chatId}`);
      break;
    }
    if (hardFailTotal >= HARD_FAIL_ABORT_TOTAL) {
      console.error(`[delivery] bail after ${hardFailTotal} cumulative hard-fails; returning ${delivered.length}/${TARGET} chat=${chatId}`);
      break;
    }
    const remaining = TARGET - delivered.length;
    const sampleSize = Math.min(Math.max(remaining * SAMPLING_MAX_MULT, remaining + SAMPLING_MIN), available);
    const candidates = await Media.aggregate([{ $match: filter }, { $sample: { size: sampleSize } }]);
    if (!candidates.length) break;
    let cursor = 0;
    let quitOuter = false;
    while (cursor < candidates.length && delivered.length < TARGET && !quitOuter && !shouldAbortChat) {
      const batch = candidates.slice(cursor, cursor + PARALLEL_BATCH_SIZE);
      cursor += batch.length;
      const results = await Promise.all(batch.map(it => deliverOne(it)));
      for (const r of results) {
        if (r.skippable) { quitOuter = true; }
      }
      if (hardFailStreak >= HARD_FAIL_ABORT_STREAK || hardFailTotal >= HARD_FAIL_ABORT_TOTAL) {
        quitOuter = true;
      }
    }
  }

  const finalSlice = delivered.slice(0, TARGET);
  const totalElapsed = Date.now() - startedAt;
  emitProgress('end', { finalCount: finalSlice.length });
  console.log(
    `[delivery] summary chat=${chatId} target=${TARGET} delivered=${finalSlice.length} ` +
    `elapsed=${totalElapsed}ms ` +
    `tier(hot=${tierCounts.hot},ub=${tierCounts.userbot},cold=${tierCounts.cold}) ` +
    `elapsed(hot=${tierElapsed.hot}ms,ub=${tierElapsed.userbot}ms,cold=${tierElapsed.cold}ms) ` +
    `streak=${hardFailStreak} fails=${hardFailTotal} abortChat=${shouldAbortChat ? 1 : 0} ubAvail=${userbotAvailable ? 1 : 0}`
  );
  return finalSlice;
}

module.exports = { deliverMedia, withRetry, BOT_KEY, hotSendMedia, coldForwardAndSeed, userbotDirectFallback, hasActiveUserbot };
