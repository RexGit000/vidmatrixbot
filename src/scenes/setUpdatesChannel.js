const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const Settings = require('../models/Settings');
const { mainAdminKeyboard } = require('../keyboards/admin');

const setUpdatesChannelScene = new Scenes.BaseScene('SET_UPDATES_CHANNEL');

function parsePublicChannelUsername(raw) {
  const text = raw.trim();
  const linkMatch = text.match(/(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{3,})/);
  if (linkMatch) return `@${linkMatch[1]}`;
  if (text.startsWith('@')) return text;
  if (/^[A-Za-z][A-Za-z0-9_]{3,}$/.test(text)) return `@${text}`;
  return null;
}

async function leave(ctx, text) {
  await ctx.reply(text, { ...mainAdminKeyboard() });
  return ctx.scene.leave();
}

setUpdatesChannelScene.enter(async (ctx) => {
  ctx.scene.state.step = 'awaiting_input';
  const current = await Settings.get('updatesChannelUsername');
  await ctx.reply(
    `📢 *Updates Channel*\n\nCurrent: ${current || '_not set_'}\n\nSend the public channel username or link.\nExamples:\n• \`@yourchannel\`\n• \`https://t.me/yourchannel\`\n\n⚠️ The bot must already be an admin there.`,
    { parse_mode: 'Markdown', ...Markup.keyboard([['❌ Cancel']]).resize() }
  );
});

setUpdatesChannelScene.on(message('text'), async (ctx) => {
  const text = ctx.message.text.trim();
  if (text === '❌ Cancel' || text === '/cancel') {
    return leave(ctx, '↩️ Cancelled.');
  }

  if (ctx.scene.state.step !== 'awaiting_input') return;

  const username = parsePublicChannelUsername(text);
  if (!username) {
    await ctx.reply('❌ Send a valid public channel username or link.');
    return;
  }

  try {
    const chat = await ctx.telegram.getChat(username);
    if (!chat?.username) {
      await ctx.reply('❌ That channel does not have a public username. Please set one first.');
      return;
    }

    const member = await ctx.telegram.getChatMember(chat.id, ctx.botInfo.id);
    if (!['administrator', 'creator'].includes(member.status)) {
      await ctx.reply('❌ The bot must be an admin in that updates channel before it can post weekly results.');
      return;
    }

    await Settings.set('updatesChannelUsername', `@${chat.username}`);
    await ctx.reply(`✅ Updates channel set to \`@${chat.username}\`.`, { parse_mode: 'Markdown' });
    return leave(ctx, '↩️ Back to admin panel.');
  } catch (err) {
    console.error('[setUpdatesChannel]', err.message);
    await ctx.reply('❌ Could not access that channel. Check the username and bot permissions, then try again.');
  }
});

module.exports = setUpdatesChannelScene;
