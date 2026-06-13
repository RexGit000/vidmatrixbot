const { Markup } = require('telegraf');
const User     = require('../models/User');
const Media    = require('../models/Media');
const Package  = require('../models/Package');
const Settings = require('../models/Settings');
const adminCache = require('../cache');
const botState = require('../services/botState');
const { mainUserKeyboard, startInlineKeyboard } = require('../keyboards/user');
const { mainAdminKeyboard, mediaManageKeyboard, adminManageKeyboard } = require('../keyboards/admin');
const { formatDate } = require('../utils/helpers');
const { POINTS_PER_MEDIA } = require('../constants');
const { buildTiersList } = require('../utils/referral');
const { buildSubscriptionSummary } = require('../services/subscriptionService');
const { getUserWeeklyStanding } = require('../services/leaderboardService');

const MEDIA_PAGE_SIZE = 5;
const USER_PAGE_SIZE  = 10;

function adminGuard(ctx) {
  if (!ctx.state.isAdmin) {
    ctx.reply('⛔ Admin access required.').catch(() => {});
    return false;
  }
  return true;
}

// Build + send (or edit) the paginated user list
async function showUserList(ctx, page, edit = false) {
  const total      = await User.countDocuments();
  const totalPages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));
  const safePage   = Math.min(page, totalPages - 1);

  const users = await User.find()
    .sort({ createdAt: -1 })
    .skip(safePage * USER_PAGE_SIZE)
    .limit(USER_PAGE_SIZE)
    .lean();

  if (!users.length) {
    const msg = '📭 No users yet.';
    if (edit) await ctx.editMessageText(msg).catch(() => {});
    else await ctx.reply(msg);
    return;
  }

  const lines = users.map((u, i) => {
    const num      = safePage * USER_PAGE_SIZE + i + 1;
    const name     = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unknown';
    const username = u.username ? ` @${u.username}` : '';
    return `${num}. *${name}*${username}\n   ID: \`${u.telegramId}\` · Invites: ${u.inviteCount} · Pts: ${u.points || 0}`;
  });

  const navRow = [];
  if (safePage > 0)              navRow.push(Markup.button.callback('◀ Prev', `user_list:${safePage - 1}`));
  navRow.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, 'noop'));
  if (safePage < totalPages - 1) navRow.push(Markup.button.callback('Next ▶', `user_list:${safePage + 1}`));

  const text     = `👥 *User List* — ${total} total\n\n${lines.join('\n\n')}`;
  const keyboard = Markup.inlineKeyboard([navRow]);
  const opts     = { parse_mode: 'Markdown', ...keyboard };

  if (edit) await ctx.editMessageText(text, opts).catch(() => {});
  else      await ctx.reply(text, opts);
}

module.exports = (bot) => {
  // ── Gift Media ────────────────────────────────────────────────────────
  bot.hears('🎁 Gift Media', async (ctx) => {
    if (!adminGuard(ctx)) return;
    return ctx.scene.enter('GIFT_MEDIA');
  });

  // ── Switch to User View ───────────────────────────────────────────────────
  bot.hears('👤 Switch to User View', async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      const user = await User.findOneAndUpdate(
        { telegramId: ctx.from.id },
        { viewMode: 'user' },
        { new: true }
      );

      const [packages, updatesChannelUsername, weeklyStanding] = await Promise.all([
        Package.find({ isActive: true }).sort('order'),
        Settings.get('updatesChannelUsername'),
        getUserWeeklyStanding(ctx.from.id),
      ]);
      const memberCount = await User.countDocuments();
      const weeklyRankText = weeklyStanding.rank ? `#${weeklyStanding.rank}` : '#--';

      const welcomeText =
        `❤️ Welcome to the Premium Video Club! 👋\n\n` +
        `🔥 *Invite friends, earn rewards, and compete weekly!*\n\n` +
        `📊 *Your Account*\n` +
        `👥 Referrals: *${user?.inviteCount || 0}*\n` +
        `🏆 Weekly Rank: *${weeklyRankText}*\n` +
        `💎 Membership: *${buildSubscriptionSummary(user?.subscription)}*\n\n` +
        `👥 *Referral Rewards:*\n${buildTiersList()}\n\n` +
        `⭐ Start inviting and unlock your rewards! ⭐`;

      await ctx.reply(welcomeText, {
        parse_mode: 'Markdown',
        ...mainUserKeyboard(true),
        ...startInlineKeyboard(user || { inviteCount: 0 }, packages, true, memberCount, updatesChannelUsername),
      });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[switch to user]', err.message);
      await ctx.reply('Error switching view.').catch(() => {});
    }
  });

  // ── Media Management ──────────────────────────────────────────────────────
  bot.hears('📁 Media Management', async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      const count = await Media.countDocuments();
      await ctx.reply(
        `📁 *Media Management*\n\n🎬 Total media in pool: *${count}*`,
        { parse_mode: 'Markdown', ...mediaManageKeyboard() }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[media management]', err.message);
      await ctx.reply('Error loading media management.').catch(() => {});
    }
  });

  // ── Media Count ───────────────────────────────────────────────────────────
  bot.action('media_count', async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      await ctx.answerCbQuery();
      const count = await Media.countDocuments();
      await ctx.editMessageText(
        `📁 *Media Management*\n\n🎬 Total media in pool: *${count}*`,
        { parse_mode: 'Markdown', ...mediaManageKeyboard() }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[media count]', err.message);
    }
  });

  // ── Media List (paginated) ────────────────────────────────────────────────
  bot.action(/^media_list:(\d+)$/, async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      await ctx.answerCbQuery();
      const page  = parseInt(ctx.match[1], 10);
      const total = await Media.countDocuments();
      const totalPages = Math.max(1, Math.ceil(total / MEDIA_PAGE_SIZE));
      const safePage   = Math.min(page, totalPages - 1);

      const items = await Media.find()
        .sort({ addedAt: -1 })
        .skip(safePage * MEDIA_PAGE_SIZE)
        .limit(MEDIA_PAGE_SIZE)
        .lean();

      if (!items.length) {
        await ctx.editMessageText('📭 No media in the pool yet.');
        return;
      }

      const rows = items.map((m) => {
        const emoji = m.fileType === 'photo' ? '📷' : '🎬';
        const label = `${emoji} ${formatDate(m.addedAt)}`;
        return [Markup.button.callback(label, `media_del_confirm:${m._id}`)];
      });

      const navRow = [];
      if (safePage > 0)              navRow.push(Markup.button.callback('◀ Prev', `media_list:${safePage - 1}`));
      navRow.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, 'noop'));
      if (safePage < totalPages - 1) navRow.push(Markup.button.callback('Next ▶', `media_list:${safePage + 1}`));
      rows.push(navRow);

      await ctx.editMessageText(
        `📋 *Media Pool* — ${total} item(s)\n_Click any item to delete it._`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard(rows) }
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[media list]', err.message);
    }
  });

  // ── Delete media — confirmation ───────────────────────────────────────────
  bot.action(/^media_del_confirm:(.+)$/, async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      await ctx.answerCbQuery();
      await ctx.editMessageText(
        'Delete this media item from the pool?',
        Markup.inlineKeyboard([
          [Markup.button.callback('🗑 Yes, delete', `media_del:${ctx.match[1]}`)],
          [Markup.button.callback('« Back',         'media_list:0')],
        ])
      );
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[media del confirm]', err.message);
    }
  });

  // ── Delete media — execute ────────────────────────────────────────────────
  bot.action(/^media_del:(.+)$/, async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      await ctx.answerCbQuery();
      const media = await Media.findByIdAndDelete(ctx.match[1]);
      if (!media) {
        await ctx.editMessageText('Media not found (already deleted?).');
        return;
      }

      await User.updateMany(
        { receivedMedia: media._id },
        { $pull: { receivedMedia: media._id } }
      );

      await ctx.editMessageText('✅ Media deleted from pool.');
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[media del]', err.message);
    }
  });

  bot.action('noop', (ctx) => ctx.answerCbQuery().catch(() => {}));

  // ── Bot on/off toggle ─────────────────────────────────────────────────────
  bot.hears(['🔴 Disable Bot', '🟢 Enable Bot'], async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      const newState = !botState.get();
      botState.set(newState);
      await Settings.set('botEnabled', newState);
      const msg = newState
        ? '🟢 Bot is now *ENABLED*. All users can interact.'
        : '🔴 Bot is now *DISABLED*. Non-admins will get no response.';
      await ctx.reply(msg, { parse_mode: 'Markdown', ...mainAdminKeyboard() });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[bot toggle]', err.message);
      await ctx.reply('Error updating bot state.').catch(() => {});
    }
  });

  // ── Admin Management ──────────────────────────────────────────────────────
  bot.hears('👥 Admin Management', async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      await ctx.reply('👥 *Admin Management*', {
        parse_mode: 'Markdown',
        ...adminManageKeyboard(),
      });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[admin management]', err.message);
      await ctx.reply('Error.').catch(() => {});
    }
  });

  bot.action('admin_add', async (ctx) => {
    if (!adminGuard(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    return ctx.scene.enter('ADD_ADMIN');
  });

  bot.action('admin_remove', async (ctx) => {
    if (!adminGuard(ctx)) return;
    await ctx.answerCbQuery().catch(() => {});
    return ctx.scene.enter('REMOVE_ADMIN');
  });

  bot.action('admin_list', async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      await ctx.answerCbQuery();
      const admins = adminCache.getAll();
      if (!admins.length) {
        await ctx.editMessageText('No admins found.');
        return;
      }
      const lines = admins.map((a, i) => {
        const id   = a.telegramId ? `ID: ${a.telegramId}` : '(no ID yet)';
        const user = a.username   ? a.username              : '(no username)';
        const role = a.isSuperAdmin ? ' 👑 Superadmin' : '';
        return `${i + 1}. ${user} — ${id}${role}`;
      });
      await ctx.editMessageText(`📋 *Admin List*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[admin list]', err.message);
    }
  });

  // ── Broadcast ─────────────────────────────────────────────────────────────
  bot.hears('📢 Broadcast', async (ctx) => {
    if (!adminGuard(ctx)) return;
    return ctx.scene.enter('BROADCAST');
  });

  // ── Package Settings ──────────────────────────────────────────────────────
  bot.hears('📦 Package Settings', async (ctx) => {
    if (!adminGuard(ctx)) return;
    return ctx.scene.enter('EDIT_PACKAGE');
  });

  // ── Set File Channel ──────────────────────────────────────────────────────
  bot.hears('📺 File Channel', async (ctx) => {
    if (!adminGuard(ctx)) return;
    return ctx.scene.enter('SET_CHANNEL');
  });

  // ── Set Updates Channel ───────────────────────────────────────────────────
  bot.hears('📢 Updates Channel', async (ctx) => {
    if (!adminGuard(ctx)) return;
    return ctx.scene.enter('SET_UPDATES_CHANNEL');
  });

  // ── User List (paginated) ─────────────────────────────────────────────────
  bot.hears('📋 User List', async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      await showUserList(ctx, 0, false);
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[user list]', err.message);
      await ctx.reply('Error loading user list.').catch(() => {});
    }
  });

  bot.action(/^user_list:(\d+)$/, async (ctx) => {
    if (!adminGuard(ctx)) return;
    try {
      await ctx.answerCbQuery();
      await showUserList(ctx, parseInt(ctx.match[1], 10), true);
    } catch (err) {
      if (err?.response?.error_code === 403) return;
      console.error('[user list page]', err.message);
    }
  });
};
