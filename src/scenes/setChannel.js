const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const Settings = require('../models/Settings');
const { mainAdminKeyboard } = require('../keyboards/admin');

const setChannelScene = new Scenes.BaseScene('SET_CHANNEL');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseChannelInput(raw) {
  const text = raw.trim();
  if (/(?:https?:\/\/)?t\.me\/\+/.test(text)) return null;
  if (/^-?\d+$/.test(text)) return text;
  const linkMatch = text.match(/(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,})/);
  if (linkMatch) return `@${linkMatch[1]}`;
  if (text.startsWith('@')) return text;
  if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(text)) return `@${text}`;
  return null;
}

async function currentChannelInfo(telegram, channelId) {
  try {
    const chat = await telegram.getChat(channelId);
    if (chat.title) {
      const safeTitle = chat.title.replace(/([_*`\[])/g, '\\$1');
      return `${safeTitle} (\`${channelId}\`)`;
    }
    return `\`${channelId}\``;
  } catch {
    return `\`${channelId}\``;
  }
}

function channelMenuKeyboard(hasChannel) {
  const rows = hasChannel
    ? [
        [Markup.button.callback('✏️ Change Channel', 'ch_change')],
        [Markup.button.callback('🗑 Remove Channel',  'ch_remove')],
        [Markup.button.callback('❌ Cancel',          'ch_cancel')],
      ]
    : [
        [Markup.button.callback('📺 Set Channel', 'ch_change')],
        [Markup.button.callback('❌ Cancel',       'ch_cancel')],
      ];
  return Markup.inlineKeyboard(rows);
}

async function leave(ctx, text) {
  await ctx.reply(text, { ...mainAdminKeyboard() });
  return ctx.scene.leave();
}

// ─── Enter ────────────────────────────────────────────────────────────────────

setChannelScene.enter(async (ctx) => {
  ctx.scene.state.step = 'menu';
  try {
    const channelId = await Settings.get('fileManagerChannel');
    if (channelId) {
      const label = await currentChannelInfo(ctx.telegram, channelId);
      await ctx.reply(
        `📺 *File Manager Channel*\n\nCurrent: ${label}\n\nWhat would you like to do?`,
        { parse_mode: 'Markdown', ...channelMenuKeyboard(true) }
      );
    } else {
      await ctx.reply(
        '📺 *File Manager Channel*\n\nNo channel is set yet.',
        { parse_mode: 'Markdown', ...channelMenuKeyboard(false) }
      );
    }
  } catch (err) {
    console.error('[setChannel enter]', err);
    return leave(ctx, '❌ Error loading channel info.');
  }
});

// ─── Menu actions ─────────────────────────────────────────────────────────────

setChannelScene.action('ch_change', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.scene.state.step = 'awaiting_input';
  await ctx.editMessageText(
    '📺 Send the channel to use as the file manager.\n\n' +
    'Accepted formats:\n' +
    '• `@username` or `username`\n' +
    '• Public link: `https://t.me/mychannel`\n' +
    '• Numeric ID: `-1001234567890` _(required for private channels)_\n\n' +
    '⚠️ The bot must already be an *admin* of the channel.',
    { parse_mode: 'Markdown' }
  );
  await ctx.reply('Send channel now:', Markup.keyboard([['❌ Cancel']]).resize());
});

setChannelScene.action('ch_remove', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🗑 Remove the file manager channel?\n\nThe bot will stop tracking new uploads until a channel is set again.',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, remove', 'ch_remove_confirm')],
      [Markup.button.callback('« Back',         'ch_back')],
    ])
  );
});

setChannelScene.action('ch_remove_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  try {
    await Settings.set('fileManagerChannel', null);
    await ctx.editMessageText('✅ File manager channel removed.');
  } catch (err) {
    console.error('[ch remove]', err);
    await ctx.editMessageText('❌ Failed to remove channel. Try again.');
  }
  return leave(ctx, '↩️ Back to admin panel.');
});

setChannelScene.action('ch_back', async (ctx) => {
  await ctx.answerCbQuery();
  const channelId = await Settings.get('fileManagerChannel');
  const label = channelId ? await currentChannelInfo(ctx.telegram, channelId) : null;
  const text = channelId
    ? `📺 *File Manager Channel*\n\nCurrent: ${label}\n\nWhat would you like to do?`
    : '📺 *File Manager Channel*\n\nNo channel is set yet.';
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...channelMenuKeyboard(!!channelId) });
});

setChannelScene.action('ch_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Cancelled.');
  return leave(ctx, '↩️ Back to admin panel.');
});

// ─── Input ────────────────────────────────────────────────────────────────────

setChannelScene.on(message('text'), async (ctx) => {
  if (ctx.scene.state.step !== 'awaiting_input') return;

  const text = ctx.message.text.trim();

  if (text === '❌ Cancel' || text === '/cancel') {
    return leave(ctx, '↩️ Cancelled.');
  }

  const chatRef = parseChannelInput(text);

  if (chatRef === null) {
    if (/t\.me\/\+/.test(text)) {
      await ctx.reply(
        '❌ Private invite links cannot be used here.\nSend the numeric channel ID instead (e.g. `-1001234567890`).\n\nForward any message from the channel to @userinfobot to find the ID.',
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply('❌ Could not recognise that as a valid channel reference. Please try again.');
    }
    return;
  }

  try {
    const chat   = await ctx.telegram.getChat(chatRef);
    const member = await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);

    if (!['administrator', 'creator'].includes(member.status)) {
      await ctx.reply(
        `❌ The bot is not an admin of *${chat.title || chatRef}*.\nAdd the bot as admin first, then try again.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await Settings.set('fileManagerChannel', chat.id.toString());
    await ctx.reply(
      `✅ File manager channel set to *${chat.title || chatRef}* (\`${chat.id}\`).`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    if (err.description?.includes('chat not found') || err.code === 400) {
      await ctx.reply('❌ Channel not found. Make sure the bot is already a member/admin and the ID or username is correct.');
    } else {
      console.error('[setChannel input]', err);
      await ctx.reply('❌ Could not access that channel. Please try again.');
    }
    return;
  }

  return leave(ctx, '↩️ Back to admin panel.');
});

module.exports = setChannelScene;
