const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const User = require('../models/User');
const { mainAdminKeyboard, cancelKeyboard } = require('../keyboards/admin');
const { formatCompactNumber, parseAdminInput } = require('../utils/helpers');
const { deliverMedia } = require('../services/mediaService');
const { deliverWithVerification } = require('../utils/mediaSendObserver');
const { adminCache } = require('../cache');

const giftMediaScene = new Scenes.BaseScene('GIFT_MEDIA');

async function leave(ctx, text) {
  await ctx.reply(text, { ...mainAdminKeyboard() });
  return ctx.scene.leave();
}

function nameCompact(user) {
  if (!user) return 'Unknown';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
  return user.username ? `${name} (@${user.username})` : name;
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
              _isTemporary: true
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

    ctx.scene.state.step = 'delivering';
    let holdMessageId = null;
    try {
      const hold = await ctx.reply(`⏳ Preparing delivery of ${formatCompactNumber(count)} items… please wait.`);
      holdMessageId = hold?.message_id ?? null;
    } catch (_errHold) {
      console.warn('[giftMedia] hold reply failed:', _errHold.message);
    }

    const progressThrottleMs = 4000;
    let lastProgressAt = 0;
    let lastProgressDelivered = -1;

    async function updateHoldProgress({ delivered, target, tierCounts, elapsedMs }) {
      if (holdMessageId == null) return;
      const now = Date.now();
      if (delivered === lastProgressDelivered && (now - lastProgressAt) < progressThrottleMs) return;
      lastProgressAt = now;
      lastProgressDelivered = delivered;
      const tier = [];
      if (tierCounts?.hot > 0) tier.push(`hot=${tierCounts.hot}`);
      if (tierCounts?.userbot > 0) tier.push(`ub=${tierCounts.userbot}`);
      if (tierCounts?.cold > 0) tier.push(`cold=${tierCounts.cold}`);
      const tierLine = tier.length ? ` [${tier.join(',')}]` : '';
      const sec = Math.round(Number(elapsedMs || 0) / 1000);
      const text =
        `⏳ Delivered ${formatCompactNumber(delivered)} / ${formatCompactNumber(target)} … running … ${sec}s elapsed${tierLine}\n` +
        `(Target: ${nameCompact(user)})`;
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, holdMessageId, null, text).catch(() => {});
      } catch (_e) {}
    }

    (async () => {
      let result = null;
      let fatalErr = null;
      try {
        result = await deliverWithVerification({
          telegram: ctx.telegram,
          chatId: user.telegramId,
          userId: Number(user.telegramId),
          finalMediaCount: count,
          userRecord: user,
          deliverMediaFn: (tg, tgt, n, opts) => {
            const combinedOpts = Object.assign({}, opts || {});
            if (!combinedOpts.onProgress) {
              combinedOpts.onProgress = function onProgress(ev, info) {
                if (ev !== 'batch' && ev !== 'begin' && ev !== 'end') return;
                try { updateHoldProgress({ delivered: info.delivered || 0, target: info.target || n, tierCounts: info.tierCounts, elapsedMs: info.elapsedMs || 0 }); } catch (_e) {}
              };
            }
            return deliverMedia(tg, tgt, n, combinedOpts);
          },
          adminIdResolver: () => adminCache.getAllSuperAdminIds(),
          botUsername: process.env.BOT_USERNAME || 'starstomediav2bot',
        });

        const promised = result.promised;
        const actual = result.actualCount;
        if (actual > 0 && actual === promised) {
          try {
            const verb = actual === 1 ? 'was' : 'were';
            await ctx.telegram.sendMessage(user.telegramId, `${actual} media ${verb} gifted to you by the admin, Enjoy🎉`);
          } catch (err) {
            console.error('[giftMedia] Failed to notify target user:', err.message);
          }
        }
      } catch (err) {
        fatalErr = err;
        console.error('[giftMedia] deliverWithVerification fatal:', err?.stack || String(err));
      }

      let reply;
      if (fatalErr) {
        reply = `❌ Gift delivery failed (internal error). ${fatalErr.message ? 'Error: ' + String(fatalErr.message).slice(0, 300) : ''}`;
      } else {
        const promised = result.promised;
        const actual = result.actualCount;
        const shortfall = result.shortfall;
        const attempts = result.attempts;
        const extra = result.attempts > 1 ? ` (Tried ${attempts} times: 1 initial + ${attempts - 1} top-ups.)` : '';
        if (shortfall > 0) {
          reply =
            `⚠️ Gift had shortfall\nRequested: ${formatCompactNumber(promised)}\nDelivered: ${formatCompactNumber(actual)}\nShortfall: ${shortfall}${extra}\nUser NOT notified (shortfall gate).\nTarget: ${nameCompact(user)}`;
        } else if (actual === 0) {
          reply =
            `❌ Gift delivered zero media items.${extra}\nRequested: ${formatCompactNumber(promised)}\nTarget: ${nameCompact(user)}`;
        } else {
          reply =
            `✅ Gift sent!${extra}\nDelivered ${formatCompactNumber(actual)} / ${formatCompactNumber(promised)} media items to ${nameCompact(user)}`;
        }
      }

      if (holdMessageId != null) {
        try { await ctx.deleteMessage(holdMessageId); } catch (_e) {}
      }
      try { await ctx.reply(reply, { ...mainAdminKeyboard() }); }
      catch (replyErr) {
        console.error('[giftMedia] final admin reply failed:', replyErr.message);
      }
      try { ctx.scene.leave(); } catch (_e) {}
    })().catch((e) => {
      console.error('[giftMedia] IIFE outer catch:', e?.stack || String(e));
      if (holdMessageId != null) {
        try { ctx.deleteMessage(holdMessageId).catch(() => {}); } catch (_e2) {}
      }
      try { ctx.reply('❌ Gift failed. Check logs.', { ...mainAdminKeyboard() }).catch(() => {}); }
      catch (_e3) {}
      try { ctx.scene.leave(); } catch (_e4) {}
    });
    return;
  }
});

module.exports = giftMediaScene;
