const User = require('../models/User');
const { WEEKLY_LEADERBOARD_REWARDS, BOT_USERNAME } = require('../constants');
const {
  getCurrentISTWeekWindow,
  getPreviousISTWeekWindow,
  formatISTDate,
} = require('../utils/time');

function getWeeklyRewardForRank(rank) {
  return WEEKLY_LEADERBOARD_REWARDS.find(
    (rule) => rank >= rule.startRank && rank <= rule.endRank
  ) || null;
}

function escapeMarkdown(text) {
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

function getDisplayName(user) {
  if (user.username) return `@${user.username}`;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return fullName || `User ${user.telegramId}`;
}

function countEventsInWindow(events, start, end) {
  if (!Array.isArray(events) || !events.length) return 0;
  return events.reduce((count, event) => {
    const joinedAt = event?.joinedAt ? new Date(event.joinedAt) : null;
    if (!joinedAt) return count;
    return joinedAt >= start && joinedAt <= end ? count + 1 : count;
  }, 0);
}

async function getWeeklyLeaderboard({ limit = 20, period = 'current' } = {}) {
  const window = period === 'previous'
    ? getPreviousISTWeekWindow()
    : getCurrentISTWeekWindow();

  const users = await User.find(
    { 'referralEvents.0': { $exists: true } },
    {
      telegramId: 1,
      username: 1,
      firstName: 1,
      lastName: 1,
      inviteCount: 1,
      createdAt: 1,
      referralEvents: 1,
    }
  ).lean();

  const entries = users
    .map((user) => ({
      ...user,
      weeklyReferrals: countEventsInWindow(user.referralEvents, window.start, window.end),
    }))
    .filter((user) => user.weeklyReferrals > 0)
    .sort((a, b) => {
      if (b.weeklyReferrals !== a.weeklyReferrals) return b.weeklyReferrals - a.weeklyReferrals;
      if ((b.inviteCount || 0) !== (a.inviteCount || 0)) return (b.inviteCount || 0) - (a.inviteCount || 0);
      if (new Date(a.createdAt).getTime() !== new Date(b.createdAt).getTime()) {
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return a.telegramId - b.telegramId;
    })
    .slice(0, limit)
    .map((user, index) => {
      const rank = index + 1;
      return {
        ...user,
        rank,
        rewardRule: getWeeklyRewardForRank(rank),
      };
    });

  return { ...window, entries };
}

async function getUserWeeklyStanding(telegramId) {
  const { entries } = await getWeeklyLeaderboard({ limit: 5000, period: 'current' });
  const entry = entries.find((item) => item.telegramId === telegramId);

  return {
    rank: entry?.rank || null,
    weeklyReferrals: entry?.weeklyReferrals || 0,
  };
}

function buildLeaderboardMessage(entries, { title = '🏆 *Weekly Referral Leaderboard*' } = {}) {
  if (!entries.length) {
    return `${title}\n\nNo weekly referrals yet. Start inviting friends to climb the rankings!`;
  }

  const lines = entries.map((entry) => {
    const prefix = entry.rank <= 3 ? ['🥇', '🥈', '🥉'][entry.rank - 1] : `${entry.rank}.`;
    const rewardText = entry.rewardRule ? ` · 🎁 ${entry.rewardRule.reward} videos` : '';
    return `${prefix} ${escapeMarkdown(getDisplayName(entry))} — *${entry.weeklyReferrals}* referrals${rewardText}`;
  });

  return `${title}\n\n${lines.join('\n')}`;
}

function buildWeeklyAnnouncement(entries, updatesChannelUsername) {
  const sections = [];

  for (const rule of WEEKLY_LEADERBOARD_REWARDS) {
    const group = entries.filter((entry) => entry.rank >= rule.startRank && entry.rank <= rule.endRank);
    if (!group.length) continue;

    if (rule.startRank === rule.endRank) {
      const winner = group[0];
      const badgeText = rule.badge
        ? ` + ${rule.badge}${rule.badgeDurationDays ? ` (${rule.badgeDurationDays} Days)` : ''}`
        : '';
      sections.push(
        `${rule.label} ${escapeMarkdown(getDisplayName(winner))} — 🎬 ${rule.reward} Videos${badgeText}`
      );
    } else if (group.length === 1) {
      sections.push(`${rule.label} ${escapeMarkdown(getDisplayName(group[0]))} — 🎬 ${rule.reward} Videos`);
    } else {
      const names = group.map((entry) => escapeMarkdown(getDisplayName(entry))).join(', ');
      sections.push(`${rule.label} ${names} — 🎬 ${rule.reward} Videos`);
    }
  }

  const updatesLine = updatesChannelUsername ? `📢 Updates: ${escapeMarkdown(updatesChannelUsername)}\n` : '';

  return (
    `🏆 *WEEKLY REWARDS DISTRIBUTED* 🏆\n\n` +
    `🎉 Congratulations to all participants!\n` +
    `✅ Weekly referral rewards have been distributed automatically.\n\n` +
    `${sections.join('\n')}\n\n` +
    `🚀 *A NEW WEEK HAS STARTED!*\n` +
    `Invite friends, climb the leaderboard, and win bigger rewards next week.\n\n` +
    `🤖 Bot: ${BOT_USERNAME}\n` +
    `${updatesLine}` +
    `✅ Auto reward distribution\n` +
    `✅ Auto leaderboard reset\n` +
    `✅ Auto channel announcement`
  );
}

function buildWeeklyWinnerNotice(entry, deliveredCount) {
  const rewardCount = entry.rewardRule?.reward || deliveredCount;
  const badgeText = entry.rewardRule?.badge
    ? `\nBadge: ${entry.rewardRule.badge}${entry.rewardRule.badgeDurationDays ? ` (${entry.rewardRule.badgeDurationDays} Days)` : ''}`
    : '';
  return (
    `🎉 Congratulations!\n\n` +
    `🏆 Weekly Leaderboard Results\n` +
    `Rank: #${entry.rank}\n` +
    `Reward: ${rewardCount} Premium Video${rewardCount !== 1 ? 's' : ''}${badgeText}\n` +
    `Delivered now: ${deliveredCount}\n\n` +
    `✅ Rewards have been added to your account.\n` +
    `🚀 Keep inviting friends for next week's championship!`
  );
}

function formatWeekRange(window) {
  return `${formatISTDate(window.start)} - ${formatISTDate(window.end)}`;
}

module.exports = {
  WEEKLY_LEADERBOARD_REWARDS,
  getWeeklyRewardForRank,
  getWeeklyLeaderboard,
  getUserWeeklyStanding,
  buildLeaderboardMessage,
  buildWeeklyAnnouncement,
  buildWeeklyWinnerNotice,
  formatWeekRange,
};
