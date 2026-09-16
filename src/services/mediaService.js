const Media = require('../models/Media');
const { enqueue } = require('./queue');

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

async function deliverMedia(telegram, chatId, count, { excludeIds = [] } = {}) {
  const delivered = [];
  const usedIds = new Set(excludeIds.map((id) => id.toString()));
  let shouldAbortChat = false;

  while (delivered.length < count && !shouldAbortChat) {
    const filter = { _id: { $nin: Array.from(usedIds) } };
    const available = await Media.countDocuments(filter);

    if (available === 0) break;

    const needed = count - delivered.length;
    const sampleSize = Math.min(Math.max(needed * 12, needed + 20), available);
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
      try {
        unwrapQueueResult(await enqueue(async () => {
          await withRetry(async () => {
            if (item.fileType === 'photo') {
              await telegram.sendPhoto(chatId, item.fileId);
            } else {
              await telegram.sendVideo(chatId, item.fileId);
            }
          });
        }));
        sentOk = true;
      } catch (primaryErr) {
        if (isBadFileIdentifierError(primaryErr)
            && item.channelId && item.channelMessageId != null) {
          try {
            unwrapQueueResult(await enqueue(async () => {
              await withRetry(async () => {
                await telegram.forwardMessage(
                  chatId,
                  item.channelId,
                  item.channelMessageId,
                  { disable_notification: true },
                );
              });
            }));
            sentOk = true;
          } catch (forwardErr) {
            if (isSkippableTelegramError(forwardErr)) {
              usedIds.add(itemId);
              shouldAbortChat = true;
              break;
            }
            console.error('[deliverMedia] forward fallback also failed item', itemId, forwardErr.message);
            usedIds.add(itemId);
            continue;
          }
        } else {
          console.error('[deliverMedia] failed to send item', itemId, primaryErr.message);
          usedIds.add(itemId);
          if (isBadFileIdentifierError(primaryErr)) {
            continue;
          }
          if (isSkippableTelegramError(primaryErr)) {
            shouldAbortChat = true;
            break;
          }
          continue;
        }
      }

      if (sentOk) {
        delivered.push(item);
        usedIds.add(itemId);
        if (delivered.length === count) break;
      }
    }
  }

  return delivered;
}

function rememberDeliveredMedia(user, items) {
  if (!user || !Array.isArray(items) || !items.length) return false;
  if (!Array.isArray(user.receivedMedia)) user.receivedMedia = [];

  const existingSet = new Set(user.receivedMedia.map((id) => id.toString()));
  let changed = false;

  for (const item of items) {
    const itemId = item._id.toString();
    if (!existingSet.has(itemId)) {
      user.receivedMedia.push(item._id);
      existingSet.add(itemId);
      changed = true;
    }
  }

  return changed;
}

async function sendQueuedMessage(telegram, chatId, text, extra = {}) {
  const r = await enqueue(async () => {
    try {
      await withRetry(async () => {
        await telegram.sendMessage(chatId, text, extra);
      });
      return true;
    } catch (err) {
      if (isSkippableTelegramError(err)) {
        console.warn('[sendQueuedMessage] skipped chat:', chatId, err.message);
        return false;
      }
      throw err;
    }
  });
  if (r instanceof Error) throw r;
  if (Array.isArray(r)) {
    const err = r.find((x) => x instanceof Error);
    if (err) throw err;
    return Array.isArray(r) ? r[r.length - 1] : r;
  }
  return r;
}

module.exports = { deliverMedia, rememberDeliveredMedia, sendQueuedMessage, withRetry, isSkippableTelegramError, isBadFileIdentifierError };
