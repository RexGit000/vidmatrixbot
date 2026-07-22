const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MINUTES = 5.5 * 60;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

function toISTDate(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS);
}

function fromISTComponents(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - IST_OFFSET_MS);
}

function getISTParts(date = new Date()) {
  const shifted = toISTDate(date);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
    weekday: shifted.getUTCDay(),
  };
}

function pad(num) {
  return String(num).padStart(2, '0');
}

function getISTDateKey(date = new Date()) {
  const parts = getISTParts(date);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function parseISTDateKey(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  return { year, month, day };
}

function getISTStartOfDay(date = new Date()) {
  const { year, month, day } = getISTParts(date);
  return fromISTComponents(year, month, day, 0, 0, 0, 0);
}

function getISTEndOfDay(date = new Date()) {
  const { year, month, day } = getISTParts(date);
  return fromISTComponents(year, month, day, 23, 59, 59, 999);
}

function getDaysInISTMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addISTDays(date = new Date(), days = 0) {
  return new Date(date.getTime() + (days * DAY_MS));
}

function addISTMonthsClamped(date = new Date(), months = 0) {
  const parts = getISTParts(date);
  const absoluteMonthIndex = ((parts.year * 12) + (parts.month - 1)) + months;
  const targetYear = Math.floor(absoluteMonthIndex / 12);
  const targetMonthIndex = ((absoluteMonthIndex % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const maxDay = getDaysInISTMonth(targetYear, targetMonth);
  const targetDay = Math.min(parts.day, maxDay);

  return fromISTComponents(
    targetYear,
    targetMonth,
    targetDay,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
}

function getISTDateFromKey(dateKey) {
  const { year, month, day } = parseISTDateKey(dateKey);
  return fromISTComponents(year, month, day, 0, 0, 0, 0);
}

function addDaysToISTDateKey(dateKey, days = 0) {
  return getISTDateKey(addISTDays(getISTDateFromKey(dateKey), days));
}

function getNextISTDayStart(date = new Date()) {
  return addISTDays(getISTStartOfDay(date), 1);
}

function getCurrentISTWeekWindow(date = new Date()) {
  const dayStart = getISTStartOfDay(date);
  const { weekday } = getISTParts(date);
  const daysSinceMonday = (weekday + 6) % 7;
  const start = addISTDays(dayStart, -daysSinceMonday);
  const nextStart = addISTDays(start, 7);
  const end = new Date(nextStart.getTime() - 1);

  return {
    start,
    end,
    nextStart,
    weekKey: `${getISTDateKey(start)}__${getISTDateKey(end)}`,
  };
}

function getPreviousISTWeekWindow(date = new Date()) {
  const current = getCurrentISTWeekWindow(date);
  const start = addISTDays(current.start, -7);
  const nextStart = current.start;
  const end = new Date(nextStart.getTime() - 1);

  return {
    start,
    end,
    nextStart,
    weekKey: `${getISTDateKey(start)}__${getISTDateKey(end)}`,
  };
}

function formatISTDateTime(date) {
  return new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatISTDate(date) {
  return new Date(date).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

module.exports = {
  DAY_MS,
  IST_OFFSET_MINUTES,
  getISTParts,
  getDaysInISTMonth,
  getISTDateKey,
  getISTDateFromKey,
  getISTStartOfDay,
  getISTEndOfDay,
  getNextISTDayStart,
  addISTDays,
  addISTMonthsClamped,
  addDaysToISTDateKey,
  getCurrentISTWeekWindow,
  getPreviousISTWeekWindow,
  formatISTDateTime,
  formatISTDate,
};
