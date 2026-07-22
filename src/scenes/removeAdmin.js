const { Scenes, Markup } = require('telegraf');
const Admin = require('../models/Admin');
const adminCache = require('../cache');
const { enqueue } = require('../services/queue');
const { mainAdminKeyboard } = require('../keyboards/admin');

const removeAdminScene = new Scenes.BaseScene('REMOVE_ADMIN');

async function leave(ctx, text) {
  await ctx.reply(text, { ...mainAdminKeyboard() });
  return ctx.scene.leave();
}

async function showAdminList(ctx) {
  const admins = adminCache.getAll();
  if (admins.length === 0) {
    return leave(ctx, '↩️ No admins found.');
  }

  const rows = admins.map((a) => {
    const label = a.telegramId
      ? `${a.username || ''} (${a.telegramId})`.trim()
      : a.username;
    const badge = a.isSuperAdmin ? ' 👑' : '';
    return [Markup.button.callback(`🗑 ${label}${badge}`, `rm_admin:${a._id}`)];
  });
  rows.push([Markup.button.callback('❌ Cancel', 'rm_admin_cancel')]);

  await ctx.reply('Select admin to remove:', Markup.inlineKeyboard(rows));
}

removeAdminScene.enter(async (ctx) => {
  await showAdminList(ctx);
});

removeAdminScene.action(/^rm_admin:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const docId = ctx.match[1];

  const admin = await Admin.findById(docId);
  if (!admin) {
    await ctx.editMessageText('Admin not found.');
    return leave(ctx, '↩️ Back to admin panel.');
  }

  if (admin.isSuperAdmin) {
    const superCount = await Admin.countDocuments({ isSuperAdmin: true });
    if (superCount <= 1) {
      await ctx.editMessageText('❌ Cannot remove the only superadmin.');
      return leave(ctx, '↩️ Back to admin panel.');
    }
  }

  if (admin.telegramId === ctx.from.id) {
    await ctx.editMessageText('❌ You cannot remove yourself.');
    return leave(ctx, '↩️ Back to admin panel.');
  }

  const label = admin.telegramId
    ? `${admin.username || ''} (${admin.telegramId})`.trim()
    : admin.username;

  await admin.deleteOne();

  if (admin.telegramId) adminCache.removeById(admin.telegramId);
  else if (admin.username) adminCache.removeByUsername(admin.username);

  const all = await Admin.find().lean();
  adminCache.set(all);

  await ctx.editMessageText(`✅ Removed admin: ${label}`);

  const remaining = adminCache.getAll().filter((a) => a.telegramId && a.telegramId !== ctx.from.id);
  for (const a of remaining) {
    enqueue(() =>
      ctx.telegram.sendMessage(a.telegramId, `🗑 Admin removed: ${label}`).catch(() => {})
    );
  }

  return leave(ctx, '↩️ Back to admin panel.');
});

removeAdminScene.action('rm_admin_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Cancelled.');
  return leave(ctx, '↩️ Back to admin panel.');
});

module.exports = removeAdminScene;
