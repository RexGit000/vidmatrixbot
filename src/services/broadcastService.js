const User = require('../models/User');
const Admin = require('../models/Admin');
const { enqueueBroadcast } = require('./queue');
const { sleep } = require('../utils/helpers');

const BATCH_SIZE = 25;
const BATCH_DELAY = 1000; // ms between batches

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

/**
 * Broadcasts a message (by copy) to all registered users.
 * @param {object} bot         - Telegraf bot instance
 * @param {object} msgInfo     - { chatId, messageId }
 * @param {Array}  linkButtons - [{ text, url }, ...]
 * @returns {{ total, sent, failed }}
 */
async function broadcastMessage(bot, msgInfo, linkButtons = []) {
  const admins = await Admin.find({ telegramId: { $ne: null } }, { telegramId: 1 }).lean();
  const adminIds = new Set(admins.map((a) => a.telegramId));

  const users = await User.find({}, { telegramId: 1 }).lean();
  const nonAdminUsers = users.filter((u) => !adminIds.has(u.telegramId));

  let sent = 0;
  let failed = 0;

  const replyMarkup =
    linkButtons.length > 0
      ? { inline_keyboard: linkButtons.map((b) => [{ text: b.text, url: b.url }]) }
      : undefined;

  for (let i = 0; i < nonAdminUsers.length; i += BATCH_SIZE) {
    const batch = nonAdminUsers.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map((user) =>
        enqueueBroadcast(async () => {
          try {
            await withRetry(async () => {
              await bot.telegram.copyMessage(
                user.telegramId,
                msgInfo.chatId,
                msgInfo.messageId,
                replyMarkup ? { reply_markup: replyMarkup } : {}
              );
            });
            sent++;
          } catch {
            failed++;
          }
        })
      )
    );

    if (i + BATCH_SIZE < nonAdminUsers.length) {
      await sleep(BATCH_DELAY);
    }
  }

  return { total: nonAdminUsers.length, sent, failed };
}

module.exports = { broadcastMessage };
