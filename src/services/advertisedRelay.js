const { parseAdvertisedChannelIds } = require('../constants/advertised');

const _recentErrors = new Map();
const _disabled = new Map();
const ONE_MIN_MS = 60_000;
const DISABLE_TTL_MS = 5 * 60_000;

function isChatNotPermanentError(err) {
  const m = String(err?.message || err?.description || err?.response?.description || '').toLowerCase();
  return m.includes('chat not found') || m.includes('bot was blocked') || m.includes('forbidden:') || m.includes('have no rights') || m.includes('user is deactivated');
}

/**
 * Silently copy a file-manager channel post into each configured advertised channel.
 * This project's bot must be able to post in the file channel and each destination.
 */
function mirrorChannelPost(telegram, { channelId, messageId }, enqueueFn) {
  const destIds = parseAdvertisedChannelIds();
  if (!destIds.length) return;

  const enqueue = typeof enqueueFn === 'function' ? enqueueFn : (fn) => fn();

  const silent = { disable_notification: true };
  const now = Date.now();

  for (const destId of destIds) {
    const destKey = String(destId);
    if (_disabled.has(destKey)) {
      const entry = _disabled.get(destKey);
      if (now - entry.until <= 0) {
        _disabled.delete(destKey);
      } else {
        continue;
      }
    }
    enqueue(async () => {
      try {
        await telegram.copyMessage(destId, channelId, messageId, silent);
        _recentErrors.delete(destKey);
      } catch (err) {
        const reason = isChatNotPermanentError(err) ? 'perm' : 'tmp';
        const msg = String(err?.message || '').slice(0, 120);
        const bucket = `${reason}|${msg}`;
        const last = _recentErrors.get(destKey);
        if (!last || last.bucket !== bucket || now - last.ts > ONE_MIN_MS) {
          _recentErrors.set(destKey, { bucket, ts: now });
          console.warn('[advertisedRelay] copy failed (throttled 1/min/dest):', destId, msg);
        }
        if (reason === 'perm') {
          const prior = _disabled.get(destKey);
          const n = prior ? Math.min(10, (prior.attempts || 1) + 1) : 1;
          _disabled.set(destKey, { until: now + DISABLE_TTL_MS * Math.max(1, n), attempts: n });
        }
      }
    });
  }
}

module.exports = { mirrorChannelPost };
