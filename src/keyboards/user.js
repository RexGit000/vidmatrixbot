const { Markup } = require('telegraf');
const { getNextTier } = require('../utils/referral');
const { getSubscriptionDurationText } = require('../services/subscriptionService');

function updatesChannelUrl(username) {
  return username ? `https://t.me/${String(username).replace(/^@/, '')}` : null;
}

function packageButtonLabel(pkg) {
  if (pkg.type === 'subscription') {
    return `👑 ${pkg.name} · ⭐ ${pkg.stars}/${getSubscriptionDurationText(pkg)} · 🎬 ${pkg.dailyMediaCount}/day`;
  }

  return `⭐ ${pkg.stars} Stars = ${pkg.mediaCount} Videos`;
}

function mainUserKeyboard(isAdmin = false) {
  const rows = [
    ['🔗 My Referral Link', '📊 My Stats'],
    ['⭐ Buy with Stars', '🎁 Buy with Points'],
  ];
  if (isAdmin) rows.push(['🔐 Switch to Admin View']);
  return Markup.keyboard(rows).resize();
}

// Colored inline keyboard attached to the /start welcome message (image-2 style).
// Uses background_color for Telegram Bot API colored button support.
function startInlineKeyboard(user, packages, isAdmin, memberCount, updatesChannelUsername) {
  const inviteCount = user.inviteCount || 0;
  const nextTier    = getNextTier(inviteCount);
  const nextStr     = nextTier
    ? `Next: ${nextTier.emoji} ${nextTier.name} (${inviteCount}/${nextTier.invites})`
    : '🏆 Max Tier!';

  const rows = [];

  rows.push([{ text: `👥 INVITE FRIENDS | ${nextStr}`,           callback_data: 'start_invite',   style: 'success' }]);
  rows.push([{ text: `❤️ My Referral Progress (${inviteCount})`, callback_data: 'ref_progress',   style: 'danger'  }]);

  for (const pkg of packages) {
    rows.push([{ text: packageButtonLabel(pkg), callback_data: `buy_pkg:${pkg._id}` }]);
  }

  rows.push([{ text: '⭐ 📊 Referral Leaderboard',               callback_data: 'ref_leaderboard', style: 'primary' }]);
  if (updatesChannelUsername) {
    rows.push([{ text: `👉 Join Now: ${updatesChannelUsername}`, url: updatesChannelUrl(updatesChannelUsername) }]);
  }

  if (isAdmin) {
    rows.push([{ text: `👥 Admin View: ${memberCount} Members`, callback_data: 'switch_admin_inline' }]);
  }

  return Markup.inlineKeyboard(rows);
}

// Transparent inline keyboard for the My Stats message (image-1 style).
function statsInlineKeyboard(user, packages, isAdmin, memberCount, updatesChannelUsername) {
  const inviteCount = user.inviteCount || 0;
  const nextTier    = getNextTier(inviteCount);
  const nextStr     = nextTier
    ? `${nextTier.emoji} ${nextTier.name} (${inviteCount}/${nextTier.invites})`
    : '🏆 Max Tier!';

  const rows = [
    [Markup.button.callback(`👥 INVITE FRIENDS | Next: ${nextStr}`, 'start_invite')],
    [Markup.button.callback(`🏆 My Referral Progress (${inviteCount} invite${inviteCount !== 1 ? 's' : ''})`, 'ref_progress')],
  ];

  for (const pkg of packages) {
    rows.push([Markup.button.callback(packageButtonLabel(pkg), `buy_pkg:${pkg._id}`)]);
  }

  rows.push([Markup.button.callback('📊 Referral Leaderboard', 'ref_leaderboard')]);
  if (updatesChannelUsername) {
    rows.push([Markup.button.url(`👉 Join Now: ${updatesChannelUsername}`, updatesChannelUrl(updatesChannelUsername))]);
  }

  if (isAdmin) {
    rows.push([Markup.button.callback(`👥 Admin View: ${memberCount} Members`, 'switch_admin_inline')]);
  }

  return Markup.inlineKeyboard(rows);
}

function packagesKeyboard(packages) {
  const rows = packages.map((pkg) => [
    Markup.button.callback(packageButtonLabel(pkg), `buy_pkg:${pkg._id}`),
  ]);
  rows.push([Markup.button.callback('« Back', 'back_to_main')]);
  return Markup.inlineKeyboard(rows);
}

module.exports = { mainUserKeyboard, startInlineKeyboard, statsInlineKeyboard, packagesKeyboard };
