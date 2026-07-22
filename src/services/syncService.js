const Media    = require('../models/Media');
const User     = require('../models/User');
const Settings = require('../models/Settings');
const adminCache = require('../cache');
const fs = require('fs');
const http = require('http');

let syncing = false;
let syncPending = false;

function getDebugConfig() {
  const fallback = { url: null, sessionId: null };
  if (process.env.DEBUG_SERVER_URL && process.env.DEBUG_SESSION_ID) {
    return { url: process.env.DEBUG_SERVER_URL, sessionId: process.env.DEBUG_SESSION_ID };
  }
  try {
    const p = '.dbg/bandwidth-memory-spike.env';
    const raw = fs.readFileSync(p, 'utf8');
    const url = raw.match(/DEBUG_SERVER_URL=(.+)/)?.[1]?.trim() || null;
    const sessionId = raw.match(/DEBUG_SESSION_ID=(.+)/)?.[1]?.trim() || null;
    return { url, sessionId };
  } catch {
    return fallback;
  }
}

function reportDebugEvent(evt) {
  try {
    const { url, sessionId } = getDebugConfig();
    if (!url || !sessionId) return;
    const u = new URL(url);
    const body = JSON.stringify({ ts: Date.now(), sessionId, ...evt });
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => res.resume()
    );
    req.on('error', () => {});
    req.end(body);
  } catch {}
}

async function checkChannelAccess(bot) {
  const channelId = await Settings.get('fileManagerChannel');
  if (!channelId) return;

  try {
    const me     = await bot.telegram.getMe();
    const member = await bot.telegram.getChatMember(channelId, me.id);
    if (!['administrator', 'creator'].includes(member.status)) {
      throw new Error('not admin');
    }
  } catch {
    const safeId = String(channelId).replace(/([_*`\[])/g, '\\$1');
    const msg = `⚠️ *File Channel Alert*\n\nThe bot has lost admin access to the file channel (\`${safeId}\`).\n\nPlease check channel permissions or set a new channel.`;
    for (const admin of adminCache.getAll().filter((a) => a.telegramId)) {
      bot.telegram.sendMessage(admin.telegramId, msg, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }
}

async function syncMediaPoolOnce(bot) {
  await checkChannelAccess(bot);

  const startedAt = Date.now();
  // #region debug-point A:sync-start
  reportDebugEvent({ runId: 'pre', hypothesisId: 'A', location: 'syncService.js:syncMediaPool', msg: '[DEBUG] syncMediaPool start', data: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed } });
  // #endregion

  const cursor = Media.find({}, { _id: 1, fileId: 1 }).lean().cursor();
  const stale = [];
  let total = 0;
  let checked = 0;
  let failures = 0;

  const MAX_CONCURRENCY = 10;
  const inflight = new Set();

  const checkOne = async (m) => {
    try {
      await bot.telegram.getFile(m.fileId);
      checked += 1;
    } catch {
      failures += 1;
      stale.push(m._id);
    }
  };

  for await (const m of cursor) {
    total += 1;
    let p;
    p = checkOne(m).finally(() => inflight.delete(p));
    inflight.add(p);
    if (inflight.size >= MAX_CONCURRENCY) {
      await Promise.race(inflight);
    }
  }

  if (inflight.size) {
    await Promise.allSettled(Array.from(inflight));
  }

  if (!total) {
    console.log('[sync] Media pool is empty, nothing to check');
    return;
  }

  console.log(`[sync] Checked ${total} media record(s)...`);

  if (!stale.length) {
    console.log('[sync] All media accessible — pool is clean');
    return;
  }

  const failRate = stale.length / total;
  if (failRate > 0.2) {
    console.warn(`[sync] ${stale.length}/${total} files failed (${Math.round(failRate * 100)}%) — looks like a token or connectivity issue, skipping deletion to avoid data loss`);
    return;
  }

  await Media.deleteMany({ _id: { $in: stale } });
  await User.updateMany(
    { receivedMedia: { $in: stale } },
    { $pull: { receivedMedia: { $in: stale } } }
  );

  console.log(`[sync] Removed ${stale.length} inaccessible record(s) and cleared from user history`);

  // #region debug-point A:sync-end
  reportDebugEvent({ runId: 'pre', hypothesisId: 'A', location: 'syncService.js:syncMediaPool', msg: '[DEBUG] syncMediaPool end', data: { total, checked, failures, staleCount: stale.length, ms: Date.now() - startedAt, rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed } });
  // #endregion
}

async function syncMediaPool(bot) {
  if (syncing) {
    syncPending = true;
    return;
  }

  syncing = true;
  try {
    await syncMediaPoolOnce(bot);
  } finally {
    syncing = false;
    if (syncPending) {
      syncPending = false;
      await syncMediaPool(bot);
    }
  }
}

module.exports = { syncMediaPool };
