require('dotenv').config();
const { Telegraf, session, Scenes } = require('telegraf');
const authMiddleware        = require('./middleware/auth');
const maintenanceMiddleware = require('./middleware/maintenance');
const scenes                = require('./scenes');

const startHandler   = require('./handlers/start');
const userHandlers   = require('./handlers/user');
const adminHandlers  = require('./handlers/admin');
const paymentHandlers = require('./handlers/payment');
const channelHandlers = require('./handlers/channel');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ── Middleware ────────────────────────────────────────────────────────────────

bot.use(session());
bot.use(authMiddleware);
bot.use(maintenanceMiddleware);

const stage = new Scenes.Stage(scenes);
bot.use(stage.middleware());

// ── Handlers ─────────────────────────────────────────────────────────────────

channelHandlers(bot);   // Must be before other handlers to catch channel_post early
paymentHandlers(bot);
startHandler(bot);
userHandlers(bot);
adminHandlers(bot);

// ── Global error handler ──────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`[bot error] update type: ${ctx.updateType}`, err);
  if (ctx.callbackQuery) {
    ctx.answerCbQuery('An error occurred. Please try again.').catch(() => {});
  } else {
    ctx.reply('An error occurred. Please try again.').catch(() => {});
  }
});

module.exports = bot;
