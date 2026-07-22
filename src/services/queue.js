const _Q = require('queue-promise');
const Queue = _Q.default ?? _Q;

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

tgQueue.on('reject', (err) => console.error('[queue] tgQueue error:', err));
broadcastQueue.on('reject', (err) => console.error('[queue] broadcastQueue error:', err));

function enqueue(fn) {
  return tgQueue.enqueue(fn);
}

function enqueueBroadcast(fn) {
  return broadcastQueue.enqueue(fn);
}

module.exports = { enqueue, enqueueBroadcast, tgQueue, broadcastQueue };
