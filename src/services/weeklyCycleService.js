const Admin = require('../models/Admin');
const Settings = require('../models/Settings');
const User = require('../models/User');
const {
  getWeeklyRewardForRank,
  getWeeklyLeaderboard,
  buildWeeklyAnnouncement,
  buildWeeklyWinnerNotice,
  formatWeekRange,
} = require('./leaderboardService');
const { deliverMedia, rememberDeliveredMedia, sendQueuedMessage, isSkippableTelegramError } = require('./mediaService');
const { getPreviousISTWeekWindow } = require('../utils/time');

async function publishWeeklyResults(bot, entries, {
  weekWindow = getPreviousISTWeekWindow(),
  updatesChannelUsername = null,
  persistUsers = true,
} = {}) {
  let winnerCount = 0;
  for (const entry of entries) {
    if (!entry.rewardRule) continue;

    winnerCount += 1;
    let user = await User.findOne({ telegramId: entry.telegramId });
    if (!user && persistUsers) {
      user = await User.create({
        telegramId: entry.telegramId,
        username: entry.username || null,
        firstName: entry.firstName || '',
        lastName: entry.lastName || '',
      });
    }

    const target = user || {
      telegramId: entry.telegramId,
      username: entry.username || null,
      firstName: entry.firstName || '',
      lastName: entry.lastName || '',
      receivedMedia: [],
    };

    const items = await deliverMedia(bot.telegram, target.telegramId, entry.rewardRule.reward, {
      excludeIds: target.receivedMedia || [],
    });

    if (persistUsers && user) {
      rememberDeliveredMedia(user, items);
      await user.save();
    }

    await sendQueuedMessage(
      bot.telegram,
      target.telegramId,
      buildWeeklyWinnerNotice(entry, items.length),
    ).catch((err) => {
      if (!isSkippableTelegramError(err)) {
        console.error('[weeklyCycle] winner DM failed:', target.telegramId, err.message);
      }
    });
  }

  if (updatesChannelUsername && entries.length) {
    await bot.telegram.sendMessage(
      updatesChannelUsername,
      `${buildWeeklyAnnouncement(entries, updatesChannelUsername)}\n\n📅 Week: ${formatWeekRange(weekWindow)}`,
      { parse_mode: 'Markdown' }
    ).catch((err) => {
      console.error('[weeklyCycle] updates channel post failed:', err.message);
    });
  }

  return { weekKey: weekWindow.weekKey, winnerCount };
}

async function processWeeklyCycle(bot, date = new Date()) {
  const previousWeek = getPreviousISTWeekWindow(date);
  const { entries } = await getWeeklyLeaderboard({ limit: 20, period: 'previous' });
  const updatesChannelUsername = await Settings.get('updatesChannelUsername');

  return publishWeeklyResults(bot, entries, {
    weekWindow: previousWeek,
    updatesChannelUsername,
  });
}

async function buildMockWeeklyEntriesFromAdmins() {
  const admins = await Admin.find({ telegramId: { $ne: null } })
    .sort({ isSuperAdmin: -1, createdAt: 1 })
    .lean();

  return admins.slice(0, 20).map((admin, index) => ({
    telegramId: admin.telegramId,
    username: admin.username ? admin.username.replace(/^@/, '') : null,
    firstName: admin.username ? admin.username.replace(/^@/, '') : `Admin ${index + 1}`,
    lastName: '',
    inviteCount: 100 - index,
    weeklyReferrals: 100 - index,
    rank: index + 1,
    rewardRule: getWeeklyRewardForRank(index + 1),
  })).filter((entry) => entry.rewardRule);
}

async function runWeeklyCycleIfNeeded(bot, date = new Date()) {
  const previousWeek = getPreviousISTWeekWindow(date);
  const lastProcessedWeekKey = await Settings.get('weeklyRewardsLastProcessedWeekKey');
  if (lastProcessedWeekKey === previousWeek.weekKey) {
    return null;
  }

  const result = await processWeeklyCycle(bot, date);
  await Settings.set('weeklyRewardsLastProcessedWeekKey', previousWeek.weekKey);
  return result;
}

module.exports = {
  buildMockWeeklyEntriesFromAdmins,
  publishWeeklyResults,
  processWeeklyCycle,
  runWeeklyCycleIfNeeded,
};
