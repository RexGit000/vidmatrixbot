const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const Admin = require('../models/Admin');
const adminCache = require('../cache');
const { parseAdminInput } = require('../utils/helpers');
const { enqueue } = require('../services/queue');
const { mainAdminKeyboard } = require('../keyboards/admin');

const addAdminScene = new Scenes.BaseScene('ADD_ADMIN');

addAdminScene.enter(async (ctx) => {
  ctx.scene.state.step = 'awaiting_input';
  await ctx.reply(
    '➕ *Add Admin*\n\nSend the admin\'s Telegram *user ID* or *@username*.\nExample: `123456789` or `@username`\n\nType /cancel to exit.',
    { parse_mode: 'Markdown', ...Markup.keyboard([['❌ Cancel']]).resize() }
  );
});

async function leave(ctx, text) {
  await ctx.reply(text, { ...mainAdminKeyboard() });
  return ctx.scene.leave();
}

addAdminScene.on(message('text'), async (ctx) => {
  const text = ctx.message.text.trim();

  if (text === '❌ Cancel' || text === '/cancel') {
    return leave(ctx, '↩️ Cancelled.');
  }

  const { telegramId, username } = parseAdminInput(text);

  const query = telegramId ? { telegramId } : { username };
  const existing = await Admin.findOne(query);
  if (existing) {
    await ctx.reply('⚠️ That admin already exists.');
    return leave(ctx, '↩️ Back to admin panel.');
  }

  ctx.scene.state.pending = { telegramId, username };
  const label = telegramId ? `ID: ${telegramId}` : `Username: ${username}`;
  await ctx.reply(
    `Confirm adding admin:\n${label}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirm', 'add_admin_confirm')],
      [Markup.button.callback('❌ Cancel',  'add_admin_cancel')],
    ])
  );
  ctx.scene.state.step = 'awaiting_confirm';
});

addAdminScene.action('add_admin_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  const { telegramId, username } = ctx.scene.state.pending || {};
  if (!telegramId && !username) {
    await ctx.editMessageText('Session expired. Please try again.');
    return leave(ctx, '↩️ Back to admin panel.');
  }

  try {
    await Admin.create({ telegramId, username, addedBy: ctx.from.id });
    const all = await Admin.find().lean();
    adminCache.set(all);

    const label = telegramId ? `ID: ${telegramId}` : `Username: ${username}`;
    await ctx.editMessageText(`✅ Admin added: ${label}`);

    const admins = adminCache.getAll().filter((a) => a.telegramId && a.telegramId !== ctx.from.id);
    for (const a of admins) {
      enqueue(() =>
        ctx.telegram.sendMessage(a.telegramId, `👤 New admin added: ${label}`).catch(() => {})
      );
    }
  } catch (err) {
    console.error('[addAdmin]', err.message);
    await ctx.editMessageText('❌ Failed to add admin. Please try again.');
  }

  return leave(ctx, '↩️ Back to admin panel.');
});

addAdminScene.action('add_admin_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Cancelled.');
  return leave(ctx, '↩️ Back to admin panel.');
});

module.exports = addAdminScene;
