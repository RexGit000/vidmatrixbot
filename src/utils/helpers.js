/**
 * Parse admin input: all-digit string → numeric ID; anything else → @username.
 * Returns { telegramId, username } — one will always be null.
 */
function parseAdminInput(raw) {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return { telegramId: parseInt(trimmed, 10), username: null };
  }
  const username = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  return { telegramId: null, username };
}

function getMessageType(message) {
  if (!message) return 'Unknown';
  if (message.text) return 'Text';
  if (message.photo) return 'Photo';
  if (message.video) return 'Video';
  if (message.audio) return 'Audio';
  if (message.voice) return 'Voice';
  if (message.video_note) return 'Video Note';
  if (message.animation) return 'GIF/Animation';
  if (message.document) return 'Document';
  if (message.sticker) return 'Sticker';
  return 'Unknown';
}

function formatDate(date) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCompactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${abs}`;
  const k = abs / 1000;
  const rounded = Math.round(k * 10) / 10;
  const str = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${sign}${str}k`;
}

module.exports = { parseAdminInput, getMessageType, formatDate, sleep, formatCompactNumber };
