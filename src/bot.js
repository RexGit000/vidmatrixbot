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

let HANDLER_TIMEOUT_MS;
{
  const raw = process.env.HANDLER_TIMEOUT_MS;
  const asInt = raw === '' || raw == null ? NaN : Number(raw);
  if (raw === '0' || asInt === 0) {
    HANDLER_TIMEOUT_MS = 0;
  } else if (Number.isFinite(asInt) && asInt > 0) {
    HANDLER_TIMEOUT_MS = asInt;
  } else {
    HANDLER_TIMEOUT_MS = 0;
  }
}

const botOptions = {};
if (HANDLER_TIMEOUT_MS > 0) {
  botOptions.handlerTimeout = HANDLER_TIMEOUT_MS;
}
const bot = new Telegraf(process.env.BOT_TOKEN, botOptions);

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
  const updateType = ctx?.updateType || 'unknown';
  const updateId = ctx?.update?.update_id ?? '';
  console.error(`[bot error] update type=${updateType} id=${updateId}`, err?.stack || String(err));
  if (ctx?.callbackQuery) {
    ctx.answerCbQuery('An error occurred.').catch(() => {});
  }
});

module.exports = bot;
