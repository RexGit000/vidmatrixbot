const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { broadcastMessage } = require('../services/broadcastService');
const { getMessageType } = require('../utils/helpers');
const { mainAdminKeyboard } = require('../keyboards/admin');
const User = require('../models/User');

const broadcastScene = new Scenes.BaseScene('BROADCAST');

async function leave(ctx, text) {
  await ctx.reply(text, { ...mainAdminKeyboard() });
  return ctx.scene.leave();
}

// ─── Enter ────────────────────────────────────────────────────────────────────

broadcastScene.enter(async (ctx) => {
  ctx.scene.state = { step: 'awaiting_message', linkButtons: [] };
  await ctx.reply(
    '📢 *Broadcast*\n\nSend the message you want to broadcast to all users.\nSupports any format: text, photo, video, audio, document, sticker, etc.',
    { parse_mode: 'Markdown', ...Markup.keyboard([['❌ Cancel']]).resize() }
  );
});

// ─── Message capture ──────────────────────────────────────────────────────────

broadcastScene.on(message(), async (ctx) => {
  const state = ctx.scene.state;
  const text  = ctx.message?.text;

  if (text === '❌ Cancel' || text === '/cancel') {
    return leave(ctx, '↩️ Broadcast cancelled.');
  }

  if (state.step === 'awaiting_message') {
    state.broadcastMsg = { chatId: ctx.chat.id, messageId: ctx.message.message_id };
    state.msgType      = getMessageType(ctx.message);
    state.step         = 'awaiting_buttons_decision';

    const userCount = await User.countDocuments();
    await ctx.reply(
      `✅ Message captured!\n\n📊 Recipients: *${userCount}* users\n📄 Type: ${state.msgType}\n\nAdd link buttons?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('➕ Add Link Buttons', 'bc_add_btn')],
          [Markup.button.callback('🚀 Send Now',         'bc_send')],
          [Markup.button.callback('❌ Cancel',           'bc_cancel')],
        ]),
      }
    );
    return;
  }

  if (state.step === 'awaiting_btn_text') {
    state.pendingBtnText = text;
    state.step = 'awaiting_btn_url';
    await ctx.reply('Now send the button URL (must start with https:// or http://):');
    return;
  }

  if (state.step === 'awaiting_btn_url') {
    if (!text?.match(/^https?:\/\/.+/)) {
      await ctx.reply('❌ Invalid URL. Must start with https:// or http://. Try again:');
      return;
    }
    state.linkButtons.push({ text: state.pendingBtnText, url: text });
    state.step = 'awaiting_buttons_decision';

    await ctx.reply(
      `✅ Button added (${state.linkButtons.length} total). Add another?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add Another Button', 'bc_add_btn')],
        [Markup.button.callback('🚀 Send Now',           'bc_send')],
        [Markup.button.callback('❌ Cancel',             'bc_cancel')],
      ])
    );
    return;
  }
});

// ─── Inline actions ───────────────────────────────────────────────────────────

broadcastScene.action('bc_add_btn', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.scene.state.step = 'awaiting_btn_text';
  await ctx.editMessageText(
    ctx.scene.state.linkButtons.length > 0
      ? `You have ${ctx.scene.state.linkButtons.length} button(s). Send the next button label:`
      : 'Send the button label (e.g. "Visit Website"):'
  );
});

broadcastScene.action('bc_send', async (ctx) => {
  await ctx.answerCbQuery();
  const state = ctx.scene.state;

  if (!state.broadcastMsg) {
    await ctx.editMessageText('No message captured. Please start over.');
    return leave(ctx, '↩️ Back to admin panel.');
  }

  const btnSummary = state.linkButtons.length > 0
    ? `\n🔘 Buttons: ${state.linkButtons.length}`
    : '';

  await ctx.editMessageText(
    `🚀 Broadcasting...\n📄 Type: ${state.msgType}${btnSummary}`
  );

  try {
    const botLike = { telegram: ctx.telegram };
    const { total, sent, failed } = await broadcastMessage(
      botLike,
      state.broadcastMsg,
      state.linkButtons
    );
    await ctx.reply(`✅ Broadcast complete!\n📤 Sent: ${sent}/${total}\n❌ Failed: ${failed}`);
  } catch (err) {
    console.error('[broadcast]', err.message);
    await ctx.reply('❌ Broadcast failed. Check logs.');
  }

  return leave(ctx, '↩️ Back to admin panel.');
});

broadcastScene.action('bc_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Broadcast cancelled.');
  return leave(ctx, '↩️ Broadcast cancelled.');
});

module.exports = broadcastScene;
