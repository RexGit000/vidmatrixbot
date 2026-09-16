const _Q = require('queue-promise');
const Queue = _Q.default ?? _Q;

function isSkippableTelegramError(err) {
  const description = String(err?.description || err?.response?.description || err?.message || '').toLowerCase();
  return (
    description.includes('bot was blocked by the user') ||
    description.includes('user is deactivated') ||
    description.includes('chat not found') ||
    description.includes('forbidden: bot was blocked') ||
    description.includes('have no rights to send a message')
  );
}

function isBadFileIdentifierError(err) {
  const desc = String(err?.description || err?.response?.description || err?.message || '').toLowerCase();
  const code = Number(err?.error_code ?? err?.response?.error_code ?? 0);
  return (
    (code === 400 && (
      desc.includes('wrong file identifier') ||
      desc.includes('file_id is invalid') ||
      desc.includes('file not found')
    ))
  );
}

function summarizeTelegramErr(err) {
  if (!err) return 'unknown';
  const method = err?.on?.method || err?.method || '';
  const payload = err?.on?.payload || {};
  const kind =
    isBadFileIdentifierError(err) ? 'bad-file-id' :
    isSkippableTelegramError(err) ? 'chat-skippable' :
    (err?.response?.error_code ?? err?.error_code ?? err?.code ?? '');
  const chatId = payload.chat_id ?? payload.chatId ?? '';
  const short = `${method ? method + ': ' : ''}${err?.response?.description || err?.description || err?.message || ''}`.trim();
  return `[${kind}] ${short}${chatId ? ` (chat=${chatId})` : ''}`;
}

function onQueueReject(label) {
  return function (err) {
    if (isBadFileIdentifierError(err) || isSkippableTelegramError(err)) {
      console.warn(`[queue] ${label}: handled -> ${summarizeTelegramErr(err)}`);
      return;
    }
    console.error(`[queue] ${label} error:`, err);
  };
}

// Main queue for single-user API calls (media delivery, admin notifications)
const tgQueue = new Queue({
  concurrent: 1,
  interval: 500,  // 2 requests per second to the same user
  start: true,
});

// Separate queue for broadcasts — slightly higher concurrency
const broadcastQueue = new Queue({
  concurrent: 3,
  interval: 200,  // 15 messages per second for broadcasts
  start: true,
});

tgQueue.on('reject', onQueueReject('tgQueue'));
broadcastQueue.on('reject', onQueueReject('broadcastQueue'));

function enqueue(fn) {
  return tgQueue.enqueue(fn);
}

function enqueueBroadcast(fn) {
  return broadcastQueue.enqueue(fn);
}

module.exports = { enqueue, enqueueBroadcast, tgQueue, broadcastQueue };
