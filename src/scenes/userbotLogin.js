const { Scenes, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { mainAdminKeyboard } = require('../keyboards/admin');
const {
  beginLogin,
  handleCancel,
  handleTextMessage,
  getSession,
  clearSession,
} = require('../bot/userbotLogin');

const userbotLoginScene = new Scenes.BaseScene('USERBOT_LOGIN');

async function leave(ctx, text) {
  clearSession(ctx.from?.id);
  if (text) {
    await ctx.reply(text, { ...mainAdminKeyboard() }).catch(() => {});
  }
  return ctx.scene.leave();
}

userbotLoginScene.enter(async (ctx) => {
  if (!ctx.state || !ctx.state.isAdmin) {
    return leave(ctx, '⛔ Admin access required.');
  }
  clearSession(ctx.from?.id);
  await beginLogin(ctx);
});

userbotLoginScene.hears('❌ Cancel', async (ctx) => {
  await handleCancel(ctx);
  return ctx.scene.leave();
});

userbotLoginScene.command('cancel', async (ctx) => {
  await handleCancel(ctx);
  return ctx.scene.leave();
});

userbotLoginScene.on(message('text'), async (ctx) => {
  const handled = await handleTextMessage(ctx);
  if (handled) {
    const session = getSession(ctx.from?.id);
    if (!session) {
      return ctx.scene.leave();
    }
  }
});

userbotLoginScene.action('cancel_userbot_login', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await handleCancel(ctx);
  return ctx.scene.leave();
});

module.exports = userbotLoginScene;
