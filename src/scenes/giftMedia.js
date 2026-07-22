const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const User = require('../models/User');
const { mainAdminKeyboard, cancelKeyboard } = require('../keyboards/admin');
const { formatCompactNumber, parseAdminInput } = require('../utils/helpers');
const { deliverMedia } = require('../services/mediaService');

const giftMediaScene = new Scenes.BaseScene('GIFT_MEDIA');

async function leave(ctx, text) {
  await ctx.reply(text, { ...mainAdminKeyboard() });
  return ctx.scene.leave();
}

async function showUserList(ctx, page = 0) {
  const USER_PAGE_SIZE = 10;
  const total = await User.countDocuments();
  const totalPages = Math.max(1, Math.ceil(total / USER_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);

  const users = await User.find()
    .sort({ createdAt: -1 })
    .skip(safePage * USER_PAGE_SIZE)
    .limit(USER_PAGE_SIZE)
    .lean();

  if (!users.length) {
    return leave(ctx, '📭 No users found.');
  }

  const rows = users.map((u) => {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Unknown';
    const username = u.username ? ` @${u.username}` : '';
    const label = `${name}${username} (ID: ${u.telegramId})`;
    return [Markup.button.callback(label, `gift_user:${u._id}`)];
  });

  const navRow = [];
  if (safePage > 0) navRow.push(Markup.button.callback('◀ Prev', `gift_user_list:${safePage - 1}`));
  navRow.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, 'noop'));
  if (safePage < totalPages - 1) navRow.push(Markup.button.callback('Next ▶', `gift_user_list:${safePage + 1}`));
  rows.push(navRow);
  rows.push([Markup.button.callback('✏️ Enter Username/ID', 'gift_enter_user')]);
  rows.push([Markup.button.callback('❌ Cancel', 'gift_cancel')]);

  await ctx.reply('Select a user to gift media:', Markup.inlineKeyboard(rows));
}

giftMediaScene.enter(async (ctx) => {
  ctx.scene.state.step = 'select_user';
  await showUserList(ctx, 0);
});

giftMediaScene.action(/^gift_user_list:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  await showUserList(ctx, parseInt(ctx.match[1], 10));
});

giftMediaScene.action(/^gift_user:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const user = await User.findById(ctx.match[1]);
  if (!user) {
    await ctx.editMessageText('User not found.');
    return leave(ctx, '↩️ Back to admin panel.');
  }
  ctx.scene.state.targetUser = user;
  ctx.scene.state.step = 'awaiting_count';
  await ctx.deleteMessage().catch(() => {});
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
  await ctx.reply(
    `🎁 Gifting media to: ${name}${user.username ? ` (@${user.username})` : ''}\n\nEnter the number of media items to gift:`,
    { ...cancelKeyboard() }
  );
});

giftMediaScene.action('gift_enter_user', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.scene.state.step = 'awaiting_user_input';
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply(
    'Enter the user\'s Telegram ID or @username to gift media:',
    { ...cancelKeyboard() }
  );
});

giftMediaScene.action('gift_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  return leave(ctx, '↩️ Cancelled.');
});

giftMediaScene.on(message('text'), async (ctx) => {
  const text = ctx.message.text.trim();

  if (text === '❌ Cancel' || text === '/cancel') {
    return leave(ctx, '↩️ Cancelled.');
  }

  if (ctx.scene.state.step === 'awaiting_user_input') {
    const { telegramId, username } = parseAdminInput(text);
    const dbUsername = username ? username.replace(/^@/, '') : null;
    const query = telegramId ? { telegramId } : (dbUsername ? { username: dbUsername } : null);
    if (!query) {
      await ctx.reply('❌ Could not recognize that. Please enter a valid Telegram ID or @username:');
      return;
    }

    let user = await User.findOne(query);

    if (!user && username) {
      user = null;
    } else if (!user && telegramId) {
      try {
        const chat = await ctx.telegram.getChat(telegramId);
        if (chat) {
          user = await User.findOne({ telegramId: chat.id });
          if (user && chat.username && user.username !== chat.username) {
            await User.updateOne({ _id: user._id }, { username: chat.username });
            user.username = chat.username;
          }
          if (!user) {
            user = {
              telegramId: chat.id,
              username: chat.username || null,
              firstName: chat.first_name || '',
              lastName: chat.last_name || '',
              receivedMedia: [],
              _isTemporary: true,
            };
          }
        }
      } catch (err) {
        console.error('[giftMedia] Failed to get chat via numeric ID:', err);
      }
    }

    if (!user) {
      await ctx.reply(
        `❌ User not found. \n\n` +
        `Note: For users who changed their username, please use their numeric Telegram ID. ` +
        `You can ask them to get it from @GetUserIdsBot, or find them in the user list above.\n\n` +
        `Please try again:`,
        { ...cancelKeyboard() }
      );
      return;
    }

    ctx.scene.state.targetUser = user;
    ctx.scene.state.step = 'awaiting_count';
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
    await ctx.reply(
      `🎁 Gifting media to: ${name}${user.username ? ` (@${user.username})` : ''}\n\nEnter the number of media items to gift:`,
      { ...cancelKeyboard() }
    );
    return;
  }

  if (ctx.scene.state.step === 'awaiting_count') {
    const count = parseInt(text, 10);
    if (isNaN(count) || count <= 0) {
      await ctx.reply('❌ Invalid number. Enter a positive integer:');
      return;
    }
    const user = ctx.scene.state.targetUser;
    if (!user) {
      return leave(ctx, '❌ Session expired. Please try again.');
    }

    try {
      const items = await deliverMedia(ctx.telegram, user.telegramId, count, { excludeIds: user.receivedMedia || [] });
      const delivered = items.length;

      if (delivered > 0 && !user._isTemporary) {
        await User.updateOne(
          { _id: user._id },
          { $addToSet: { receivedMedia: { $each: items.map((item) => item._id) } } }
        );
      }

      if (delivered > 0) {
        try {
          const verb = delivered === 1 ? 'was' : 'were';
          await ctx.telegram.sendMessage(
            user.telegramId,
            `${delivered} media ${verb} gifted to you by the admin, Enjoy🎉`
          );
        } catch (err) {
          console.error('[giftMedia] Failed to notify user:', err.message);
        }
      }

      const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
      await ctx.reply(
        `✅ Gift sent!\nDelivered ${formatCompactNumber(delivered)} media items to ${name}${user.username ? ` (@${user.username})` : ''}`,
        { ...mainAdminKeyboard() }
      );
      return ctx.scene.leave();
    } catch (err) {
      console.error('[giftMedia]', err);
      await ctx.reply('❌ Failed to deliver media. Check logs.', { ...mainAdminKeyboard() });
      return ctx.scene.leave();
    }
  }
});

module.exports = giftMediaScene;
