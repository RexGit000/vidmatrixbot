const User    = require('../models/User');
const Package = require('../models/Package');
const Settings = require('../models/Settings');
const adminCache = require('../cache');
const { getUserWeeklyStanding } = require('../services/leaderboardService');
const { sendQueuedMessage } = require('../services/mediaService');
const { buildSubscriptionSummary } = require('../services/subscriptionService');
const { mainUserKeyboard, startInlineKeyboard } = require('../keyboards/user');
const { mainAdminKeyboard } = require('../keyboards/admin');
const { buildAdminStats } = require('../utils/stats');

module.exports = (bot) => {
  bot.start(async (ctx) => {
    try {
      const { id, username, first_name, last_name } = ctx.from;
      const args = ctx.startPayload;

      const isNewUser = !(await User.exists({ telegramId: id }));

      const user = await User.findOneAndUpdate(
        { telegramId: id },
        { $set: { username: username || null, firstName: first_name || '', lastName: last_name || '' } },
        { upsert: true, new: true }
      );

      // Handle referral
      const referrerId = parseInt(args, 10);
      const hasReferral = args && !isNaN(referrerId);

      if (hasReferral) {
        if (referrerId === id) {
          await ctx.reply("You can't use your own referral link.");
        } else if (!isNewUser) {
          await ctx.reply("Referral links only apply to new accounts — you're already registered.");
        } else {
          const referrer = await User.findOne({ telegramId: referrerId });
          if (referrer) {
            user.referrerId = referrerId;
            await user.save();

            referrer.inviteCount += 1;
            referrer.referralEvents.push({
              referredUserId: id,
              joinedAt: new Date(),
            });
            await referrer.save();

            const joinerName = first_name + (username ? ` (@${username})` : '');
            const refMsg =
              `👥 *New referral!*\n${joinerName} joined using your link.\n\n` +
              `Total invites: *${referrer.inviteCount}*\n` +
              `🏆 Weekly leaderboard tracking has been updated.`;

            sendQueuedMessage(ctx.telegram, referrerId, refMsg, { parse_mode: 'Markdown' }).catch(() => {});
          }
        }
      }

      const isAdmin = adminCache.isAdmin(id, username);

      if (isAdmin && user.viewMode === 'admin') {
        const stats = await buildAdminStats(ctx.telegram);
        await ctx.reply(
          `Welcome back, ${first_name}!\n\n${stats}`,
          { parse_mode: 'Markdown', ...mainAdminKeyboard() }
        );
        return;
      }

      // User mode — show welcome with referral tiers and colored inline keyboard
      const [packages, updatesChannelUsername, weeklyStanding] = await Promise.all([
        Package.find({ isActive: true }).sort('order'),
        Settings.get('updatesChannelUsername'),
        getUserWeeklyStanding(id),
      ]);
      const memberCount = isAdmin ? await User.countDocuments() : 0;
      const weeklyRankText = weeklyStanding.rank ? `#${weeklyStanding.rank}` : '#--';

      const welcomeText =
        `❤️ Welcome to the Premium Video Club! 👋\n\n` +
        `🔥 *Invite friends and compete weekly!*\n\n` +
        `📊 *Your Account*\n` +
        `👥 Referrals: *${user.inviteCount || 0}*\n` +
        `🏆 Weekly Rank: *${weeklyRankText}*\n` +
        `💎 Membership: *${buildSubscriptionSummary(user.subscription)}*\n\n` +
        `🏆 *Weekly Championship*\n` +
        `🥇 #1 = 700 videos\n` +
        `   + Champion Badge (7 Days)\n` +
        `� #2 = 600 videos\n` +
        `   + Elite Badge (7 Days)\n` +
        `🥉 #3 = 500 videos\n` +
        `   + Promoter Badge (7 Days)\n` +
        `🏅 #4-5 = 230 videos\n` +
        `🏅 #6-10 = 170 videos\n` +
        `🏅 #11-20 = 15 videos\n\n` +
        `⭐ Start inviting and climb the leaderboard! ⭐`;

      await ctx.reply(welcomeText, {
        parse_mode: 'Markdown',
        ...mainUserKeyboard(isAdmin),
        ...startInlineKeyboard(user, packages, isAdmin, memberCount, updatesChannelUsername),
      });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[start handler]', err.message);
      await ctx.reply('Something went wrong. Please try again.').catch(() => {});
    }
  });
};
