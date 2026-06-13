const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const Package = require('../models/Package');
const { mainAdminKeyboard } = require('../keyboards/admin');

const editPackageScene = new Scenes.BaseScene('EDIT_PACKAGE');

async function leave(ctx, text) {
  await ctx.reply(text, { ...mainAdminKeyboard() });
  return ctx.scene.leave();
}

async function showPackageList(ctx) {
  const packages = await Package.find({ isActive: true }).sort('order');
  if (!packages.length) {
    return leave(ctx, '↩️ No packages found.');
  }
  const rows = packages.map((p) => [
    Markup.button.callback(
      p.type === 'subscription'
        ? `👑 ${p.name} · ⭐ ${p.stars} → 🎬 ${p.dailyMediaCount}/day [edit]`
        : `⭐ ${p.stars} Stars → 🎬 ${p.mediaCount} Media [edit]`,
      `edit_pkg:${p._id}`
    ),
  ]);
  rows.push([Markup.button.callback('❌ Cancel', 'edit_pkg_cancel')]);
  await ctx.reply('Select a package to edit its star cost:', Markup.inlineKeyboard(rows));
}

editPackageScene.enter(async (ctx) => {
  ctx.scene.state.step = 'select';
  await showPackageList(ctx);
});

editPackageScene.action(/^edit_pkg:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pkg = await Package.findById(ctx.match[1]);
  if (!pkg) {
    await ctx.editMessageText('Package not found.');
    return leave(ctx, '↩️ Back to admin panel.');
  }
  ctx.scene.state.pkgId = ctx.match[1];
  ctx.scene.state.step  = 'awaiting_stars';
  await ctx.editMessageText(
    `Editing: *${pkg.name}*\nCurrent cost: ⭐ ${pkg.stars} Stars\n\nEnter new star cost:`,
    { parse_mode: 'Markdown' }
  );
  await ctx.reply('Send new star amount:', Markup.keyboard([['❌ Cancel']]).resize());
});

editPackageScene.action('edit_pkg_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Cancelled.');
  return leave(ctx, '↩️ Back to admin panel.');
});

editPackageScene.on(message('text'), async (ctx) => {
  const text = ctx.message.text.trim();

  if (text === '❌ Cancel' || text === '/cancel') {
    return leave(ctx, '↩️ Cancelled.');
  }

  if (ctx.scene.state.step !== 'awaiting_stars') return;

  const stars = parseInt(text, 10);
  if (isNaN(stars) || stars <= 0) {
    await ctx.reply('❌ Invalid number. Enter a positive integer:');
    return;
  }

  const pkg = await Package.findByIdAndUpdate(
    ctx.scene.state.pkgId,
    { stars },
    { new: true }
  );

  await ctx.reply(
    pkg.type === 'subscription'
      ? `✅ *${pkg.name}* updated → ⭐ ${pkg.stars} Stars for 🎬 ${pkg.dailyMediaCount} media/day.`
      : `✅ *${pkg.name}* updated → ⭐ ${pkg.stars} Stars for 🎬 ${pkg.mediaCount} Media.`,
    { parse_mode: 'Markdown' }
  );
  return leave(ctx, '↩️ Back to admin panel.');
});

module.exports = editPackageScene;
