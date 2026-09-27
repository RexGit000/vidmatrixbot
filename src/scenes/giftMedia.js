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
      const hold = await ctx.reply(`⏳ Preparing ${count} gift item${count === 1 ? '' : 's'} for ${nameCompact(user)}…`);
      holdMessageId = hold?.message_id ?? null;
    } catch (_errHold) {
      console.warn('[giftMedia] hold reply failed:', _errHold.message);
    }

    const progressThrottleMs = 5000;
    let lastProgressAt = 0;
    let lastProgressDelivered = -1;

    async function updateHoldProgress({ delivered, target, elapsedMs }) {
      if (holdMessageId == null) return;
      const now = Date.now();
      if (delivered === lastProgressDelivered && (now - lastProgressAt) < progressThrottleMs) return;
      lastProgressAt = now;
      lastProgressDelivered = delivered;
      const sec = Math.round(Number(elapsedMs || 0) / 1000);
      const targetText = target ? ` / ${target}` : '';
      const text =
        `⏳ Gift in progress… ${delivered}${targetText} sent` +
        (sec >= 10 ? ` (${sec}s so far)` : '') +
        `\nTo: ${nameCompact(user)}`;
      try {
        // #region debug-point H3:progress-edit
        (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H3',location:'giftMedia.js:updateHoldProgress',msg:'[DEBUG] progress edit call',data:{holdMessageId,delivered,target,text:text.length,sec},ts:Date.now()})}).catch(()=>{})})();
        // #endregion
        await ctx.telegram.editMessageText(ctx.chat.id, holdMessageId, null, text)
          .then(() => {
            // #region debug-point H3:progress-edit-ok
            (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H3',location:'giftMedia.js:updateHoldProgress-ok',msg:'[DEBUG] progress edit success',data:{delivered,target,sec},ts:Date.now()})}).catch(()=>{})})();
            // #endregion
          })
          .catch((editErr) => {
            // #region debug-point H3:progress-edit-err
            (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H3',location:'giftMedia.js:updateHoldProgress-err',msg:'[DEBUG] progress edit err',data:{delivered,target,err:String(editErr?.message||editErr).slice(0,160)},ts:Date.now()})}).catch(()=>{})})();
            // #endregion
          });
      } catch (_e) {}
    }

    (async () => {
      let result = null;
      let fatalErr = null;
      try {
        // #region debug-point H1:iife-start
        (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H1',location:'giftMedia.js:iife-start',msg:'[DEBUG] gift IIFE starting deliverWithVerification',data:{count:count,userTelegramId:user.telegramId,userId:user.id,holdMessageId,adminChatId:ctx.chat?.id},ts:Date.now()})}).catch(()=>{})})();
        // #endregion
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
                try { updateHoldProgress({ delivered: info.delivered || 0, target: info.target || n, elapsedMs: info.elapsedMs || 0 }); } catch (_e) {}
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
            await ctx.telegram.sendMessage(user.telegramId, `🎁 You just got ${actual} gifted media from the admin — enjoy!`);
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
        // #region debug-point H1:iife-fatal
        (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H1',location:'giftMedia.js:iife-fatal',msg:'[DEBUG] gift fatal err',data:{err:String(fatalErr?.message||fatalErr).slice(0,220),stack:(fatalErr?.stack||'').slice(0,240)},ts:Date.now()})}).catch(()=>{})})();
        // #endregion
        reply = `❌ Gift failed to send. ${fatalErr.message ? 'Error: ' + String(fatalErr.message).slice(0, 220) : ''}`;
      } else {
        const promised = result.promised;
        const actual = result.actualCount;
        const shortfall = result.shortfall;
        // #region debug-point H1:iife-done
        (()=>{const fs=require('fs'),p='.dbg/gift-progress-stuck.env';let u='http://127.0.0.1:7777/event',s='gift-progress-stuck';try{const e=fs.readFileSync(p,'utf8');u=e.match(/DEBUG_SERVER_URL=(.+)/)?.[1]||u;s=e.match(/DEBUG_SESSION_ID=(.+)/)?.[1]||s}catch{}fetch(u,{method:'POST',body:JSON.stringify({sessionId:s,runId:'pre',hypothesisId:'H1',location:'giftMedia.js:iife-done',msg:'[DEBUG] gift IIFE done dWV result',data:{promised,actual,shortfall,attempts:result.attempts,lastReturnedCount:result.lastReturnedCount},ts:Date.now()})}).catch(()=>{})})();
        // #endregion
        if (shortfall > 0) {
          reply =
            `⚠️ Not enough media in the pool to fill this gift.\n` +
            `Asked for ${promised} but only ${actual} were available.\n` +
            `(${shortfall} missing. We did NOT message the user.)\n` +
            `To: ${nameCompact(user)}`;
        } else if (actual === 0) {
          reply =
            `⚠️ Couldn't send any gift media right now.\n` +
            `Asked for ${promised} but 0 were delivered.\n` +
            `To: ${nameCompact(user)}`;
        } else {
          reply =
            `✅ Gift sent.\n` +
            `${actual} of ${promised} delivered to ${nameCompact(user)}.`;
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
