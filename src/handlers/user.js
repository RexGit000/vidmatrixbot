const { Markup } = require('telegraf');
const User    = require('../models/User');
const Media   = require('../models/Media');
const Package = require('../models/Package');
const Settings = require('../models/Settings');
const adminCache = require('../cache');
const { POINTS_PER_MEDIA } = require('../constants');
const { REFERRAL_TIERS, getCurrentTier, getNextTier } = require('../utils/referral');
const { mainUserKeyboard, packagesKeyboard, statsInlineKeyboard } = require('../keyboards/user');
const { mainAdminKeyboard } = require('../keyboards/admin');
const { buildAdminStats } = require('../utils/stats');
const { deliverMedia, rememberDeliveredMedia } = require('../services/mediaService');
const { getWeeklyLeaderboard, getUserWeeklyStanding, buildLeaderboardMessage } = require('../services/leaderboardService');
const {
  buildSubscriptionSummary,
  hasActiveSubscription,
  getSubscriptionDurationText,
} = require('../services/subscriptionService');
const { formatISTDate } = require('../utils/time');

async function unseenCount(user) {
  if (!user.receivedMedia?.length) return await Media.countDocuments();
  return await Media.countDocuments({ _id: { $nin: user.receivedMedia } });
}

async function executeRedemption(ctx, bot, user, qty, mode) {
  const excludeIds = mode === 'unseen' ? (user.receivedMedia || []) : [];
  const items = await deliverMedia(bot.telegram, ctx.from.id, qty, { excludeIds });
  const delivered = items.length;
  const cost = delivered * POINTS_PER_MEDIA;

  user.points = (user.points || 0) - cost;
  rememberDeliveredMedia(user, items);
  await user.save();

  return { delivered, cost };
}

module.exports = (bot) => {
  // ── /invite command ───────────────────────────────────────────────────────
  bot.command('invite', async (ctx) => {
    try {
      const user = await User.findOne({ telegramId: ctx.from.id });
      const botUsername = ctx.botInfo.username;
      const refLink     = `https://t.me/${botUsername}?start=${ctx.from.id}`;
      const inviteCount = user?.inviteCount || 0;
      const nextTier    = getNextTier(inviteCount);
      const nextStr     = nextTier
        ? `📊 Next: ${nextTier.emoji} *${nextTier.name}* — ${inviteCount}/${nextTier.invites} invites`
        : '🏆 *Max tier reached!*';
      await ctx.reply(
        `🔗 *Your Referral Link:*\n\`${refLink}\`\n\n${nextStr}\n\nShare and earn FREE videos for every friend who joins! 🎁`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[/invite]', err.message);
    }
  });

  // ── /stats command ────────────────────────────────────────────────────────
  bot.command('stats', async (ctx) => {
    try {
      const user = await User.findOne({ telegramId: ctx.from.id });
      if (!user) { await ctx.reply('Send /start first to register.'); return; }

      const points      = user.points || 0;
      const inviteCount = user.inviteCount || 0;
      const redeemable  = Math.floor(points / POINTS_PER_MEDIA);
      const curTier     = getCurrentTier(inviteCount);
      const nextTier    = getNextTier(inviteCount);
      const weeklyStanding = await getUserWeeklyStanding(ctx.from.id);
      const subscriptionSummary = buildSubscriptionSummary(user.subscription);

      let text =
        `📊 *My Stats*\n\n` +
        `👥 Invites: *${inviteCount}*\n` +
        `🏆 Weekly Rank: *${weeklyStanding.rank ? `#${weeklyStanding.rank}` : '#--'}* (${weeklyStanding.weeklyReferrals} weekly referrals)\n` +
        `🌟 Points: *${points}* (${redeemable} media redeemable)\n` +
        `💎 Subscription: *${subscriptionSummary}*\n` +
        `📅 Joined: ${user.createdAt.toDateString()}\n\n` +
        `🏆 *Referral Progress*\n`;
      if (curTier) text += `Current: ${curTier.emoji} *${curTier.name}*\n`;
      if (nextTier) {
        const needed = nextTier.invites - inviteCount;
        text += `Next: ${nextTier.emoji} *${nextTier.name}* — ${inviteCount}/${nextTier.invites}\n`;
        text += `\n⭐ Invite *${needed}* more to unlock *${nextTier.reward}* free videos!`;
      } else {
        text += '🎊 *Max tier reached!*';
      }

      if (hasActiveSubscription(user.subscription)) {
        text += `\n\n👑 *Active VIP Plan*\n`;
        text += `Plan: *${user.subscription.packageName}*\n`;
        text += `Daily delivery: *${user.subscription.dailyMediaCount}* media/day\n`;
        text += `Expires: *${formatISTDate(user.subscription.expiresAt)}*`;
      }

      const [packages, updatesChannelUsername] = await Promise.all([
        Package.find({ isActive: true }).sort('order'),
        Settings.get('updatesChannelUsername'),
      ]);
      const isAdmin     = adminCache.isAdmin(ctx.from.id, ctx.from.username);
      const memberCount = isAdmin ? await User.countDocuments() : 0;
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...statsInlineKeyboard(user, packages, isAdmin, memberCount, updatesChannelUsername),
      });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[/stats]', err.message);
    }
  });

  // ── My Referral Link ──────────────────────────────────────────────────────
  bot.hears('🔗 My Referral Link', async (ctx) => {
    try {
      const user = await User.findOne({ telegramId: ctx.from.id });
      const botUsername = ctx.botInfo.username;
      const refLink = `https://t.me/${botUsername}?start=${ctx.from.id}`;
      const inviteCount = user?.inviteCount || 0;
      const nextTier = getNextTier(inviteCount);

      const nextStr = nextTier
        ? `📊 Next: ${nextTier.emoji} *${nextTier.name}* — ${inviteCount}/${nextTier.invites} invites`
        : '🏆 *Max tier reached!*';

      await ctx.reply(
        `🔗 *Your Referral Link:*\n\`${refLink}\`\n\n` +
        `${nextStr}\n\n` +
        `Share this link and earn FREE videos when friends join! 🎁`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[referral link]', err.message);
      await ctx.reply('Could not generate link. Try again.').catch(() => {});
    }
  });

  // ── My Stats ──────────────────────────────────────────────────────────────
  bot.hears('📊 My Stats', async (ctx) => {
    try {
      const user = await User.findOne({ telegramId: ctx.from.id });
      if (!user) { await ctx.reply('You are not registered. Send /start first.'); return; }

      const points      = user.points || 0;
      const inviteCount = user.inviteCount || 0;
      const redeemable  = Math.floor(points / POINTS_PER_MEDIA);
      const claimed     = new Set(user.claimedTiers || []);
      const curTier     = getCurrentTier(inviteCount);
      const nextTier    = getNextTier(inviteCount);
      const weeklyStanding = await getUserWeeklyStanding(ctx.from.id);
      const subscriptionSummary = buildSubscriptionSummary(user.subscription);

      let text =
        `📊 *My Stats*\n\n` +
        `👥 Invites: *${inviteCount}*\n` +
        `🏆 Weekly Rank: *${weeklyStanding.rank ? `#${weeklyStanding.rank}` : '#--'}* (${weeklyStanding.weeklyReferrals} weekly referrals)\n` +
        `🌟 Points: *${points}* (${redeemable} media redeemable)\n` +
        `💎 Subscription: *${subscriptionSummary}*\n` +
        `📅 Joined: ${user.createdAt.toDateString()}\n\n` +
        `🏆 *Referral Progress*\n`;

      if (curTier) text += `Current Tier: ${curTier.emoji} *${curTier.name}*\n`;
      else         text += `No tier yet — invite *2* friends to unlock Bronze!\n`;

      if (nextTier) {
        const needed = nextTier.invites - inviteCount;
        text += `Next Tier: ${nextTier.emoji} *${nextTier.name}* (${inviteCount}/${nextTier.invites} invites)\n`;
        text += `\n⭐ Invite *${needed}* more friend${needed !== 1 ? 's' : ''} to reach *${nextTier.name}* and unlock *${nextTier.reward}* free videos!`;
      } else {
        text += `🎊 *Max tier reached!* You're a Legend!\n`;
      }

      const claimedList = REFERRAL_TIERS.filter((t) => claimed.has(t.id));
      if (claimedList.length) {
        text += `\n\n✅ *Earned Tier Rewards:*\n`;
        text += claimedList.map((t) => `${t.emoji} ${t.name}: +${t.reward} free videos`).join('\n');
      }

      if (hasActiveSubscription(user.subscription)) {
        text += `\n\n👑 *Active VIP Plan*\n`;
        text += `Plan: *${user.subscription.packageName}*\n`;
        text += `Daily delivery: *${user.subscription.dailyMediaCount}* media/day\n`;
        text += `Expires: *${formatISTDate(user.subscription.expiresAt)}*`;
      }

      const [packages, updatesChannelUsername] = await Promise.all([
        Package.find({ isActive: true }).sort('order'),
        Settings.get('updatesChannelUsername'),
      ]);
      const isAdmin    = adminCache.isAdmin(ctx.from.id, ctx.from.username);
      const memberCount = isAdmin ? await User.countDocuments() : 0;

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...statsInlineKeyboard(user, packages, isAdmin, memberCount, updatesChannelUsername),
      });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[my stats]', err.message);
      await ctx.reply('Could not fetch stats. Try again.').catch(() => {});
    }
  });

  // ── Buy with Stars ────────────────────────────────────────────────────────
  bot.hears('⭐ Buy with Stars', async (ctx) => {
    try {
      const packages = await Package.find({ isActive: true }).sort('order');
      if (!packages.length) { await ctx.reply('No packages available right now. Check back later!'); return; }
      await ctx.reply('Choose a media pack or VIP subscription:', packagesKeyboard(packages));
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[buy with stars]', err.message);
      await ctx.reply('Could not load packages. Try again.').catch(() => {});
    }
  });

  // ── Buy with Points — quantity picker ─────────────────────────────────────
  bot.hears('🎁 Buy with Points', async (ctx) => {
    try {
      const user = await User.findOne({ telegramId: ctx.from.id });
      if (!user) { await ctx.reply('You are not registered. Send /start first.'); return; }

      const points = user.points || 0;
      const max    = Math.floor(points / POINTS_PER_MEDIA);
      if (max === 0) {
        const needed = POINTS_PER_MEDIA - points;
        await ctx.reply(
          `🌟 You have *${points}* point${points !== 1 ? 's' : ''}.\nYou need *${needed}* more to get 1 media item.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const nums = Array.from({ length: Math.min(max, 10) }, (_, i) => i + 1);
      const rows = [];
      for (let i = 0; i < nums.length; i += 5) {
        rows.push(nums.slice(i, i + 5).map((n) => Markup.button.callback(String(n), `redeem_qty:${n}`)));
      }
      if (max > 10) rows.push([Markup.button.callback(`Max (${max})`, `redeem_qty:${max}`)]);
      rows.push([Markup.button.callback('✖ Cancel', 'redeem_cancel')]);

      await ctx.reply(
        `🌟 You have *${points}* points.\nHow many media items do you want? *(max ${max}, costs ${POINTS_PER_MEDIA} pts each)*`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[buy with points]', err.message);
      await ctx.reply('Could not load points. Try again.').catch(() => {});
    }
  });

  // ── Quantity chosen ───────────────────────────────────────────────────────
  bot.action(/^redeem_qty:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const qty  = parseInt(ctx.match[1], 10);
      const user = await User.findOne({ telegramId: ctx.from.id });
      const points = user?.points || 0;
      const max    = Math.floor(points / POINTS_PER_MEDIA);

      if (qty > max) {
        await ctx.editMessageText(
          `❌ Not enough points for ${qty} items (need ${qty * POINTS_PER_MEDIA}, have ${points}).`
        );
        return;
      }

      const unseen = await unseenCount(user);

      if (unseen === 0) {
        const total = await Media.countDocuments();
        await ctx.editMessageText(
          `You've already bought all *${total}* media we have right now.\n\nWant us to send them again anyway, or would you rather wait for new uploads?`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
            [Markup.button.callback(`Send again (${qty} items · ${qty * POINTS_PER_MEDIA} pts)`, `redeem_exec:${qty}:mixed`)],
            [Markup.button.callback('✖ Cancel — wait for new uploads', 'redeem_cancel')],
          ]) }
        );
      } else if (unseen < qty) {
        await ctx.editMessageText(
          `We only have *${unseen}* item${unseen !== 1 ? 's' : ''} you haven't seen yet — less than your order of *${qty}*.\n\n` +
          `Do you want just the *${unseen}* new ones, or should we fill the rest with media you've already bought to complete your full order?`,
          { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
            [Markup.button.callback(`${unseen} new only · ${unseen * POINTS_PER_MEDIA} pts`, `redeem_exec:${unseen}:unseen`)],
            [Markup.button.callback(`${qty} total, fill with seen · ${qty * POINTS_PER_MEDIA} pts`, `redeem_exec:${qty}:mixed`)],
            [Markup.button.callback('✖ Cancel', 'redeem_cancel')],
          ]) }
        );
      } else {
        await ctx.editMessageText(
          `🎁 Delivering *${qty}* item${qty !== 1 ? 's' : ''} for *${qty * POINTS_PER_MEDIA}* pts...`,
          { parse_mode: 'Markdown' }
        );
        const { delivered, cost } = await executeRedemption(ctx, bot, user, qty, 'unseen');
        await ctx.reply(
          `✅ Delivered *${delivered}* item${delivered !== 1 ? 's' : ''}! Spent *${cost}* pts. Balance: *${user.points}* pts.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[redeem qty]', err.message);
      await ctx.reply('Something went wrong. Try again.').catch(() => {});
    }
  });

  // ── Execute confirmed redemption ───────────────────────────────────────────
  bot.action(/^redeem_exec:(\d+):(unseen|mixed)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const qty  = parseInt(ctx.match[1], 10);
      const mode = ctx.match[2];
      const user = await User.findOne({ telegramId: ctx.from.id });
      const points = user?.points || 0;

      if (qty * POINTS_PER_MEDIA > points) {
        await ctx.editMessageText(`❌ Not enough points (need ${qty * POINTS_PER_MEDIA}, have ${points}).`);
        return;
      }

      await ctx.editMessageText(
        `🎁 Delivering *${qty}* item${qty !== 1 ? 's' : ''}...`,
        { parse_mode: 'Markdown' }
      );
      const { delivered, cost } = await executeRedemption(ctx, bot, user, qty, mode);
      await ctx.reply(
        `✅ Delivered *${delivered}* item${delivered !== 1 ? 's' : ''}! Spent *${cost}* pts. Balance: *${user.points}* pts.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[redeem exec]', err.message);
      await ctx.reply('Delivery failed. Try again.').catch(() => {});
    }
  });

  bot.action('redeem_cancel', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  // ── Buy package (inline button) ───────────────────────────────────────────
  bot.action(/^buy_pkg:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const pkg = await Package.findById(ctx.match[1]);
      if (!pkg) { await ctx.answerCbQuery('Package not found.', true); return; }
      await ctx.replyWithInvoice({
        title:          pkg.type === 'subscription' ? `${pkg.name} Subscription` : `${pkg.mediaCount} Media Pack`,
        description:    pkg.type === 'subscription'
          ? `${pkg.dailyMediaCount} media per day for ${getSubscriptionDurationText(pkg)}.`
          : `Get ${pkg.mediaCount} exclusive media items instantly!`,
        payload:        `${pkg.type === 'subscription' ? 'sub' : 'pkg'}:${pkg._id}`,
        currency:       'XTR',
        prices:         [{ label: pkg.name, amount: pkg.stars }],
        provider_token: '',
      });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[buy pkg]', err.message);
      await ctx.reply('Could not create invoice. Try again.').catch(() => {});
    }
  });

  // ── Back to main (from packages keyboard) ─────────────────────────────────
  bot.action('back_to_main', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      await ctx.deleteMessage().catch(() => {});
      const isAdmin = adminCache.isAdmin(ctx.from.id, ctx.from.username);
      await ctx.reply('Main menu:', mainUserKeyboard(isAdmin));
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[back to main]', err.message);
    }
  });

  // ── Offers (show packages) ────────────────────────────────────────────────
  bot.action('view_offers', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const packages = await Package.find({ isActive: true }).sort('order');
      if (!packages.length) {
        await ctx.answerCbQuery('No packages available right now.', true);
        return;
      }
      await ctx.reply('🎁 *Choose a Media Pack or VIP Plan:*', {
        parse_mode: 'Markdown',
        ...packagesKeyboard(packages),
      });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[view offers]', err.message);
    }
  });

  // ── Invite Friends (from inline button) ───────────────────────────────────
  bot.action('start_invite', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await User.findOne({ telegramId: ctx.from.id });
      const botUsername = ctx.botInfo.username;
      const refLink     = `https://t.me/${botUsername}?start=${ctx.from.id}`;
      const inviteCount = user?.inviteCount || 0;
      const nextTier    = getNextTier(inviteCount);

      const nextStr = nextTier
        ? `📊 Next: ${nextTier.emoji} *${nextTier.name}* — ${inviteCount}/${nextTier.invites} invites`
        : '🏆 *Max tier reached!*';

      await ctx.reply(
        `🔗 *Your Referral Link:*\n\`${refLink}\`\n\n${nextStr}\n\n` +
        `Share this link and earn FREE videos when friends join! 🎁`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Close', 'close_message')]]),
        }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[start invite]', err.message);
    }
  });

  // ── Referral Progress (from inline button) ────────────────────────────────
  bot.action('ref_progress', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const user = await User.findOne({ telegramId: ctx.from.id });
      const inviteCount = user?.inviteCount || 0;
      const claimed     = new Set(user?.claimedTiers || []);
      const curTier     = getCurrentTier(inviteCount);
      const nextTier    = getNextTier(inviteCount);

      const tierLines = REFERRAL_TIERS.map((t) => {
        const done   = claimed.has(t.id);
        const status = done ? '✅' : (inviteCount >= t.invites ? '🔓' : '⬜');
        return `${status} ${t.emoji} *${t.name}*: ${t.invites} invites → ${t.reward} free videos`;
      });

      let progressStr = `👥 Total Invites: *${inviteCount}*\n`;
      if (curTier)  progressStr += `🏆 Current: ${curTier.emoji} *${curTier.name}*\n`;
      if (nextTier) {
        const needed = nextTier.invites - inviteCount;
        progressStr += `📊 Next: ${nextTier.emoji} *${nextTier.name}* — invite *${needed}* more!`;
      } else {
        progressStr += '🎊 *Max tier reached!*';
      }

      await ctx.reply(
        `🏆 *Referral Progress*\n\n${progressStr}\n\n*All Tiers:*\n${tierLines.join('\n')}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Close', 'close_message')]]),
        }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[ref progress]', err.message);
    }
  });

  // ── Referral Leaderboard ──────────────────────────────────────────────────
  bot.action('ref_leaderboard', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const { entries } = await getWeeklyLeaderboard({ limit: 20, period: 'current' });

      if (!entries.length) {
        await ctx.reply(
          '🏆 No weekly referrals yet! Be the first to invite friends and climb the leaderboard!',
          Markup.inlineKeyboard([[Markup.button.callback('🗑 Close', 'close_message')]])
        );
        return;
      }

      await ctx.reply(
        buildLeaderboardMessage(entries),
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🗑 Close', 'close_message')]]),
        }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[ref leaderboard]', err.message);
    }
  });

  // ── Switch to Admin (from inline button on start/stats message) ───────────
  bot.action('switch_admin_inline', async (ctx) => {
    try {
      await ctx.answerCbQuery();
      if (!ctx.state.isAdmin) {
        await ctx.answerCbQuery('⛔ Admin access required.', true);
        return;
      }
      await User.updateOne({ telegramId: ctx.from.id }, { viewMode: 'admin' });
      const stats = await buildAdminStats(ctx.telegram);
      await ctx.reply(stats, { parse_mode: 'Markdown', ...mainAdminKeyboard() });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[switch admin inline]', err.message);
    }
  });

  // ── Close/delete a bot message ────────────────────────────────────────────
  bot.action('close_message', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  // ── Switch to Admin View (reply keyboard) ──────────────────────────────────
  bot.hears('🔐 Switch to Admin View', async (ctx) => {
    try {
      if (!ctx.state.isAdmin) { await ctx.reply('You do not have admin access.'); return; }
      await User.updateOne({ telegramId: ctx.from.id }, { viewMode: 'admin' });
      const stats = await buildAdminStats(ctx.telegram);
      await ctx.reply(stats, { parse_mode: 'Markdown', ...mainAdminKeyboard() });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[switch to admin]', err.message);
      await ctx.reply('Error switching view.').catch(() => {});
    }
  });
};
