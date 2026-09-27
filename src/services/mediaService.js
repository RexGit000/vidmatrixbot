const { LRUCache } = require('lru-cache');
const Media = require('../models/Media');
const UserbotAccount = require('../models/UserbotAccount');
const Settings = require('../models/Settings');
const { deliveryCache } = require('../cache');
const { enqueueDeliver } = require('./queue');

const BOT_KEY = String(process.env.CURRENT_BOT_KEY || (process.env.BOT_TOKEN || '').split(':')[0] || 'default').trim();

const pendingPromiseCache = new LRUCache({ max: 1000, ttl: 60 * 1000 });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry(fn, maxRetries = 5) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await fn();
    } catch (err) {
      if (err.response && err.response.error_code === 429 && err.response.parameters && err.response.parameters.retry_after) {
        const retryAfter = err.response.parameters.retry_after * 1000;
        console.log(`[withRetry] Got 429, waiting ${retryAfter}ms...`);
        await sleep(retryAfter);
        retries++;
      } else {
        throw err;
      }
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
    const row = await UserbotAccount.findOne({ session: { $ne: null, $exists: true } })
      .select('_id')
      .limit(1)
      .lean();
    return !!row;
  } catch (err) {
    console.error('[delivery] hasActiveUserbot error:', err.message);
    return false;
  }
}

async function hotSendMedia(telegram, chatId, row, replyToMessageId) {
  try {
    const botKey = BOT_KEY;
    const fid = row && row.bot_file_ids ? row.bot_file_ids[botKey] : null;
    if (!fid) return { ok: false, reason: 'no_file_id' };

    const kind = row && row.metadata && typeof row.metadata.kind === 'string' ? row.metadata.kind.toLowerCase() : 'video';
    const baseExtra = {};
    if (replyToMessageId) baseExtra.reply_to_message_id = replyToMessageId;

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
      });
    }));
    return { ok: true, via: `hot_send_${kind}` };
  } catch (err) {
    if (isSkippableTelegramError(err)) {
      return { ok: false, reason: 'chat_skippable', error: err, skippable: true };
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
      unwrapQueueResult(await enqueueDeliver(async () => {
        await withRetry(async () => {
          msg = await telegram.copyMessage(chatId, row.source.channel_id, row.source.message_id, extra);
        });
      }));
    } catch (forwardErr) {
      lastError = forwardErr;
      if (isSkippableTelegramError(forwardErr)) {
        return { ok: false, reason: 'chat_skippable', error: forwardErr, skippable: true };
      }
      try {
        unwrapQueueResult(await enqueueDeliver(async () => {
          await withRetry(async () => {
            msg = await telegram.forwardMessage(chatId, row.source.channel_id, row.source.message_id, extra);
          });
        }));
      } catch (err) {
        lastError = err;
        msg = null;
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
    if (isSkippableTelegramError(err)) {
      return { ok: false, reason: 'chat_skippable', error: err, skippable: true };
    }
    console.error('[delivery] coldForwardAndSeed error:', err.message);
    return { ok: false, reason: 'cold_error', error: err };
  }
}

async function userbotDirectFallback(row, chatId) {
  try {
    const ok = await hasActiveUserbot();
    if (!ok) {
      console.warn('[delivery] userbot fallback skipped: no userbot session in DB (plan 4/5 silent).');
      return { ok: false, reason: 'no_userbot_session' };
    }
    return { ok: false, reason: 'userbot_engine_stub' };
  } catch (err) {
    console.error('[delivery] userbotDirectFallback error:', err.message);
    return { ok: false, reason: 'userbot_error', error: err };
  }
}

async function deliverMedia(telegram, chatId, count, { excludeIds = [] } = {}) {
  const delivered = [];
  const usedIds = new Set(excludeIds.map((id) => id.toString()));
  let shouldAbortChat = false;

  let fileManagerChannelId = null;
  try {
    fileManagerChannelId = await Settings.get('fileManagerChannel');
  } catch (_e) { /* ignore */ }

  while (delivered.length < count && !shouldAbortChat) {
    const filter = { _id: { $nin: Array.from(usedIds) } };
    const available = await Media.countDocuments(filter);

    if (available === 0) break;

    const needed = count - delivered.length;
    const sampleSize = Math.min(Math.max(needed * 40, needed + 80), available);
    const pipeline = [
      { $match: filter },
      { $sample: { size: sampleSize } },
    ];
    const candidates = await Media.aggregate(pipeline);

    if (!candidates.length) break;

    for (const item of candidates) {
      const itemId = item._id.toString();
      if (usedIds.has(itemId)) continue;

      let sentOk = false;
      let skippableHit = false;

      let res = await hotSendMedia(telegram, chatId, item);
      if (res && res.ok) {
        sentOk = true;
      } else if (res && res.skippable) {
        skippableHit = true;
      }

      if (!sentOk && !skippableHit) {
        res = await coldForwardAndSeed(telegram, chatId, item, null, fileManagerChannelId);
        if (res && res.ok) {
          sentOk = true;
        } else if (res && res.skippable) {
          skippableHit = true;
        }
      }

      if (!sentOk && !skippableHit) {
        res = await userbotDirectFallback(item, chatId);
        if (res && res.ok) {
          sentOk = true;
        }
      }

      if (skippableHit) {
        usedIds.add(itemId);
        shouldAbortChat = true;
        break;
      }

      if (sentOk) {
        delivered.push(item);
        usedIds.add(itemId);
        if (delivered.length === count) break;
      } else {
        usedIds.add(itemId);
        continue;
      }
    }
  }

  return delivered;
}

module.exports = { deliverMedia, withRetry, BOT_KEY, hotSendMedia, coldForwardAndSeed, userbotDirectFallback, hasActiveUserbot };
