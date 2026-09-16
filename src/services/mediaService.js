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

async function resolveAndReuploadMedia(telegram, chatId, item) {
  const token = process.env.BOT_TOKEN || '';
  if (!token) throw new Error('BOT_TOKEN missing for reupload fallback');
  const fileInfo = await telegram.getFile(item.fileId);
  const filePath = fileInfo.file_path;
  if (!filePath) throw new Error('getFile returned no file_path');
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const resp = await fetch(downloadUrl);
  if (!resp.ok) throw new Error(`Download ${resp.status}: ${resp.statusText}`);
  const ab = await resp.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf || buf.length === 0) throw new Error('Downloaded empty buffer');
  const ext = (filePath.split('/').pop() || 'file').split('.').pop() || (item.fileType === 'photo' ? 'jpg' : 'mp4');
  const filename = `media.${ext}`;
  if (item.fileType === 'photo') {
    await telegram.sendPhoto(chatId, { source: buf, filename });
  } else {
    await telegram.sendVideo(chatId, { source: buf, filename });
  }
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
        if (isBadFileIdentifierError(primaryErr)) {
          if (item.channelId && item.channelMessageId != null) {
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
              try {
                unwrapQueueResult(await enqueue(async () => {
                  await withRetry(async () => {
                    await resolveAndReuploadMedia(telegram, chatId, item);
                  }, 3);
                }));
                sentOk = true;
              } catch (reupErr) {
                console.error('[deliverMedia] forward+reupload both failed item', itemId, summarizeErr(forwardErr), summarizeErr(reupErr));
                usedIds.add(itemId);
                continue;
              }
            }
          } else {
            try {
              unwrapQueueResult(await enqueue(async () => {
                await withRetry(async () => {
                  await resolveAndReuploadMedia(telegram, chatId, item);
                }, 3);
              }));
              sentOk = true;
            } catch (reupErr) {
              console.error('[deliverMedia] reupload fallback failed item', itemId, summarizeErr(primaryErr), summarizeErr(reupErr));
              usedIds.add(itemId);
              continue;
            }
          }
        } else {
          console.error('[deliverMedia] failed to send item', itemId, primaryErr.message);
          usedIds.add(itemId);
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

function summarizeErr(err) {
  if (!err) return '';
  return String(err?.message || err?.description || err?.response?.description || err).slice(0, 160);
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
