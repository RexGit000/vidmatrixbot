const { message } = require('telegraf/filters');
const Package = require('../models/Package');
const User    = require('../models/User');
const { deliverMedia } = require('../services/mediaService');
const { formatCompactNumber } = require('../utils/helpers');

/**
 * Telegram Stars (XTR) payment flow:
 *   1. Bot sends invoice  currency:'XTR', provider_token:''
 *   2. Telegram sends pre_checkout_query  → bot must answer within 10 s
 *   3. User confirms  → Telegram charges Stars from their balance
 *   4. Telegram sends successful_payment message  → bot delivers media
 *
 * Stars always go to the account that owns the bot token (set via BotFather).
 */

module.exports = (bot) => {
  // Step 2 — must answer immediately, never queue this
  bot.on('pre_checkout_query', async (ctx) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      console.error('[pre_checkout]', err.message);
      try {
        await ctx.answerPreCheckoutQuery(false, 'Something went wrong. Please try again.');
      } catch { /* ignore */ }
    }
  });

  // Step 4 — typed filter guarantees this only fires on actual payment messages
  bot.on(message('successful_payment'), async (ctx) => {
    try {
      const payment = ctx.message.successful_payment;
      const payload = payment.invoice_payload; // "pkg:<mongoId>"

      let mediaCount = 3;

      if (payload.startsWith('pkg:')) {
        const pkg = await Package.findById(payload.slice(4)).lean();
        if (pkg) mediaCount = pkg.mediaCount;
      }

      await ctx.reply(`✅ Payment confirmed! Delivering your ${formatCompactNumber(mediaCount)} media item(s)...`);

      // Stars are already charged — deliver the full order (mix seen/unseen as needed)
      const user = await User.findOne({ telegramId: ctx.from.id });
      const items = await deliverMedia(bot.telegram, ctx.from.id, mediaCount);
      const delivered = items.length;

      // Track received history
      if (user && items.length) {
        const existingSet = new Set((user.receivedMedia || []).map((id) => id.toString()));
        for (const item of items) {
          const id = item._id.toString();
          if (!existingSet.has(id)) { user.receivedMedia.push(item._id); existingSet.add(id); }
        }
        await user.save();
      }

      await ctx.reply(`🎬 Enjoy your ${formatCompactNumber(delivered)} item(s)!`);
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[successful_payment]', err.message);
      await ctx.reply(
        '⚠️ Payment received but delivery failed. Please contact support.'
      ).catch(() => {});
    }
  });
};
