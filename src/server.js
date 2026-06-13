require('dotenv').config({ override: true });
const express  = require('express');
const connectDB    = require('./db');
const Admin        = require('./models/Admin');
const Settings     = require('./models/Settings');
const adminCache   = require('./cache');
const botState     = require('./services/botState');
const bot          = require('./bot');
const { syncMediaPool } = require('./services/syncService');
const { runDailySubscriptionCycleIfNeeded } = require('./services/subscriptionService');
const { runWeeklyCycleIfNeeded } = require('./services/weeklyCycleService');
const { seedAdmins } = require('./seed');

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SCHEDULE_INTERVAL_MS = 60 * 1000; // 1 minute

const PORT = process.env.PORT || 3000;

// ── Process-level safety nets ─────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/ping', (_req, res) => res.send('hello world'));

// Express error middleware
app.use((err, _req, res, _next) => {
  console.error('[express error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    await connectDB();

    await seedAdmins();

    // Load admin cache into memory
    const admins = await Admin.find().lean();
    adminCache.set(admins);
    console.log(`Admin cache loaded: ${admins.length} admin(s)`);

    // Load bot on/off state (default true if never set)
    const savedBotState = await Settings.get('botEnabled');
    botState.set(savedBotState !== false);
    console.log(`Bot state: ${botState.get() ? 'enabled' : 'disabled'}`);

    // Start Express
    app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

    // Verify token + get bot identity (plain API call, works before launch)
    const me = await bot.telegram.getMe();
    console.log(`Bot connected: @${me.username} (ID: ${me.id})`);

    // Register bot command menu (the "/" list users see in Telegram)
    await bot.telegram.setMyCommands([
      { command: 'start',  description: '🏠 Welcome & referral rewards'  },
      { command: 'invite', description: '🔗 Get your referral link'       },
      { command: 'stats',  description: '📊 Your stats & tier progress'   },
    ]);
    console.log('Bot commands registered.');

    // Media pool sync — run once on boot, then every 30 minutes
    syncMediaPool(bot).catch((err) => console.error('[sync] Boot run failed:', err));
    setInterval(() => {
      syncMediaPool(bot).catch((err) => console.error('[sync] Periodic run failed:', err));
    }, SYNC_INTERVAL_MS);

    // Time-based jobs — use IST day/week helpers inside the services
    const runScheduledJobs = async () => {
      try {
        await runDailySubscriptionCycleIfNeeded(bot);
      } catch (err) {
        console.error('[schedule] daily subscription cycle failed:', err);
      }

      try {
        await runWeeklyCycleIfNeeded(bot);
      } catch (err) {
        console.error('[schedule] weekly cycle failed:', err);
      }
    };

    runScheduledJobs().catch((err) => console.error('[schedule] boot run failed:', err));
    setInterval(() => {
      runScheduledJobs().catch((err) => console.error('[schedule] periodic run failed:', err));
    }, SCHEDULE_INTERVAL_MS);

    // Graceful shutdown
    process.once('SIGINT',  () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

    // Start long-polling — promise never resolves (infinite loop), so don't await
    bot.launch().catch((err) => {
      if (err?.message !== 'Aborted') console.error('[bot]', err);
    });
  } catch (err) {
    console.error('[boot error]', err.message);
  }
}

boot();
