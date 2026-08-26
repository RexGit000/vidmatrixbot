require('dotenv').config({ override: true });
const express  = require('express');
const connectDB    = require('./db');
const Admin        = require('./models/Admin');
const Settings     = require('./models/Settings');
const User         = require('./models/User');
const Order        = require('./models/Order');
const adminCache   = require('./cache');
const botState     = require('./services/botState');
const bot          = require('./bot');
const { syncMediaPool } = require('./services/syncService');
const { runDailySubscriptionCycleIfNeeded } = require('./services/subscriptionService');
const { runWeeklyCycleIfNeeded } = require('./services/weeklyCycleService');
const { deliverMedia } = require('./services/mediaService');
const { seedAdmins } = require('./seed');

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SCHEDULE_INTERVAL_MS = 60 * 1000; // 1 minute

const PORT = Number(process.env.port || process.env.PORT || 3002);

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const app = express();
app.use(express.json());

let pingCount = 0;
let lastPingAt = null;

app.get('/ping', (req, res) => {
  pingCount += 1;
  lastPingAt = new Date();
  res.set('Cache-Control', 'no-store');
  res.status(200).send('hello world');
});

app.get('/', (_req, res) => res.redirect('/stats'));

app.get('/stats', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const mem = process.memoryUsage();
  res.status(200).json({
    ok: true,
    now: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    pingCount,
    lastPingAt: lastPingAt ? lastPingAt.toISOString() : null,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
  });
});

app.post('/api/verify-order', async (req, res) => {
  try {
    const { userId, orderId, amount } = req.body;
    if (!userId || !orderId || amount == null) {
      res.status(400).json({ ok: false, error: 'Missing fields' });
      return;
    }

    const userExists = await User.exists({ telegramId: Number(userId) });
    if (!userExists) {
      res.status(200).json({ ok: false, error: 'User not found' });
      return;
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      res.status(200).json({ ok: false, error: 'Order not found' });
      return;
    }

    if (order.userId !== Number(userId)) {
      res.status(200).json({ ok: false, error: 'Order user mismatch' });
      return;
    }

    if (Number(order.amount) !== Number(amount)) {
      res.status(200).json({ ok: false, error: 'Amount mismatch' });
      return;
    }

    res.status(200).json({
      ok: true,
      orderId: String(order._id),
      userId: order.userId,
      amount: order.amount,
      mediaCount: order.mediaCount,
      packageName: order.packageName,
    });
  } catch (err) {
    console.error('[verify-order]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/verify-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ ok: false, error: 'Missing token' });
      return;
    }

    const order = await Order.findOne({ paymentToken: token }).lean();
    if (!order) {
      res.status(200).json({ ok: false, error: 'Invalid token' });
      return;
    }

    const userExists = await User.exists({ telegramId: order.userId });
    if (!userExists) {
      res.status(200).json({ ok: false, error: 'User not found' });
      return;
    }

    res.status(200).json({
      ok: true,
      orderId: String(order._id),
      userId: order.userId,
      amount: order.amount,
      mediaCount: order.mediaCount,
      packageName: order.packageName,
    });
  } catch (err) {
    console.error('[verify-token]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.post('/api/payment-success', async (req, res) => {
  try {
    const { userId, orderId, amount, mediaCount, packageName, telegramPaymentChargeId } = req.body;
    if (!userId || !orderId) {
      res.status(400).json({ ok: false, error: 'Missing fields' });
      return;
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      res.status(200).json({ ok: false, error: 'Order not found' });
      return;
    }

    if (order.userId !== Number(userId)) {
      res.status(200).json({ ok: false, error: 'Order user mismatch' });
      return;
    }

    const chatId = order.chatId;
    const msgId = order.paymentLinkMsgId;
    const finalMediaCount = Number(mediaCount || order.mediaCount);
    const finalPackageName = packageName || order.packageName;
    const finalAmount = Number(amount || order.amount);

    await Order.findByIdAndDelete(orderId);

    if (msgId) {
      bot.telegram.deleteMessage(chatId, msgId).catch(() => {});
    }

    res.status(200).json({ ok: true });

    (async () => {
      try {
        await bot.telegram.sendMessage(
          chatId,
          `✅ *Payment Confirmed!*\n\n` +
          `💰 *${finalAmount} Stars* ⭐\n` +
          `📦 Package: *${finalPackageName}*\n` +
          `🎬 Delivering your ${finalMediaCount} media item(s)...`,
          { parse_mode: 'Markdown' }
        );

        const items = await deliverMedia(bot.telegram, Number(userId), finalMediaCount);
        const delivered = items.length;

        const user = await User.findOne({ telegramId: Number(userId) });
        if (user && items.length) {
          const existingSet = new Set((user.receivedMedia || []).map((id) => id.toString()));
          for (const item of items) {
            const id = item._id.toString();
            if (!existingSet.has(id)) { user.receivedMedia.push(item._id); existingSet.add(id); }
          }
          await user.save();
        }

        await bot.telegram.sendMessage(
          chatId,
          `🎬 Enjoy your ${delivered} item(s)!`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        if (err?.response?.error_code === 403) return;
        console.error('[payment-success delivery]', err.message);
        bot.telegram.sendMessage(
          chatId,
          '⚠️ Payment confirmed but delivery had an issue. Please contact support.'
        ).catch(() => {});
      }
    })();
  } catch (err) {
    console.error('[payment-success]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  }
});

app.use((err, _req, res, _next) => {
  console.error('[express error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    await connectDB();

    await seedAdmins();

    // Load admin cache into memory
    const admins = await Admin.find().lean();
    adminCache.set(admins);
    console.log(`Admin cache loaded: ${admins.length} admin(s)`);

    // Load bot on/off state. For safety always boot ENABLED (never get stuck disabled).
    // Admins can still toggle via panel after boot if needed.
    const savedBotState = await Settings.get('botEnabled');
    if (savedBotState === false) {
      await Settings.set('botEnabled', true);
      console.log('[boot] botEnabled was disabled in DB — force-resetting to ENABLED');
    } else if (savedBotState === null || savedBotState === undefined) {
      await Settings.set('botEnabled', true);
      console.log('[boot] botEnabled was unset — defaulting to ENABLED');
    }
    botState.set(true);
    console.log('Bot state: enabled');

    // Verify token + get bot identity (plain API call, works before launch)
    const me = await bot.telegram.getMe();
    console.log(`Bot connected: @${me.username} (ID: ${me.id})`);

    // Clear any stale webhook from prior deployments, then start long-polling
    try {
      const hookInfo = await bot.telegram.getWebhookInfo();
      if (hookInfo && hookInfo.url) {
        console.log(`[boot] Stale webhook found: ${hookInfo.url} — dropping it for long-poll`);
        await bot.telegram.deleteWebhook();
      }
    } catch (err) {
      console.warn('[boot] webhook cleanup skipped:', err.message);
    }

    // Register bot command menu (the "/" list users see in Telegram)
    await bot.telegram.setMyCommands([
      { command: 'start',  description: '🏠 Welcome & weekly leaderboard'  },
      { command: 'invite', description: '🔗 Get your referral link'       },
      { command: 'stats',  description: '📊 Your stats & weekly progress'   },
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

    // Start long-polling — promise never resolves (infinite loop), so don't await
    bot.launch().catch((err) => {
      if (err?.message !== 'Aborted') console.error('[bot]', err);
    });
    console.log('[bot] long-poll launched — receiving updates');
  } catch (err) {
    console.error('[boot error]', err);
  }
}

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

boot();
