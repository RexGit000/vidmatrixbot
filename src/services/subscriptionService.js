const User = require('../models/User');
const Settings = require('../models/Settings');
const { deliverMedia, rememberDeliveredMedia, sendQueuedMessage } = require('./mediaService');
const {
  getISTDateKey,
  getISTEndOfDay,
  getNextISTDayStart,
  addISTDays,
  addISTMonthsClamped,
  formatISTDate,
  formatISTDateTime,
  getISTStartOfDay,
} = require('../utils/time');

function hasActiveSubscription(subscription, date = new Date()) {
  return Boolean(
    subscription &&
    subscription.packageId &&
    subscription.deliveryStartsAt &&
    subscription.expiresAt &&
    new Date(subscription.expiresAt) >= date
  );
}

function buildSubscriptionSummary(subscription) {
  if (!hasActiveSubscription(subscription)) return 'Free User';

  return [
    subscription.packageName,
    `${getSubscriptionDurationText(subscription)} / ${subscription.dailyMediaCount} 🎬 per day`,
    `expires ${formatISTDate(subscription.expiresAt)}`,
  ].join(' | ');
}

function getSubscriptionDurationText(subscriptionLike) {
  if (subscriptionLike?.durationMonths > 0) {
    return `${subscriptionLike.durationMonths} months`;
  }
  if (subscriptionLike?.durationDays > 0) {
    return `${subscriptionLike.durationDays} days`;
  }
  return 'custom duration';
}

function calculateSubscriptionExpiry(baseEnd, subscriptionLike) {
  if (subscriptionLike?.durationMonths > 0) {
    return getISTEndOfDay(addISTMonthsClamped(baseEnd, subscriptionLike.durationMonths));
  }

  return getISTEndOfDay(addISTDays(baseEnd, subscriptionLike?.durationDays || 0));
}

async function activateSubscription(user, pkg, purchasedAt = new Date()) {
  const current = user.subscription || {};
  const existingActive = hasActiveSubscription(current, purchasedAt);
  const baseStart = existingActive && current.deliveryStartsAt
    ? new Date(current.deliveryStartsAt)
    : getNextISTDayStart(purchasedAt);

  const baseEnd = existingActive && current.expiresAt
    ? new Date(current.expiresAt)
    : addISTDays(baseStart, -1);

  const expiresAt = calculateSubscriptionExpiry(baseEnd, pkg);

  user.subscription = {
    packageId: pkg._id,
    packageName: pkg.name,
    stars: pkg.stars,
    dailyMediaCount: pkg.dailyMediaCount,
    durationDays: pkg.durationDays,
    durationMonths: pkg.durationMonths || 0,
    perks: pkg.perks || [],
    deliveryStartsAt: baseStart,
    expiresAt,
    lastDeliveredDayKey: current.lastDeliveredDayKey || null,
    reminder2DaySentFor: null,
    finalNoticeSentFor: null,
    purchasedAt,
  };

  await user.save();
  return user.subscription;
}

async function processDailySubscriptions(bot, date = new Date()) {
  const dayKey = getISTDateKey(date);
  const dayStart = getISTStartOfDay(date);

  const users = await User.find({
    'subscription.packageId': { $ne: null },
    'subscription.expiresAt': { $gte: dayStart },
  });

  let deliveredUsers = 0;
  let reminderUsers = 0;
  let finalNoticeUsers = 0;

  for (const user of users) {
    const subscription = user.subscription;
    if (!subscription?.packageId || !subscription.deliveryStartsAt || !subscription.expiresAt) continue;

    const deliveryStartsAt = new Date(subscription.deliveryStartsAt);
    const expiresAt = new Date(subscription.expiresAt);
    const expiresDayKey = getISTDateKey(expiresAt);
    const reminderDayKey = getISTDateKey(addISTDays(expiresAt, -2));

    if (
      deliveryStartsAt <= dayStart &&
      expiresAt >= dayStart &&
      subscription.lastDeliveredDayKey !== dayKey
    ) {
      const items = await deliverMedia(bot.telegram, user.telegramId, subscription.dailyMediaCount, {
        excludeIds: user.receivedMedia || [],
      });

      rememberDeliveredMedia(user, items);
      subscription.lastDeliveredDayKey = dayKey;
      await user.save();

      if (items.length > 0) {
        deliveredUsers += 1;
        await sendQueuedMessage(
          bot.telegram,
          user.telegramId,
          `🎁 Your ${subscription.packageName} daily delivery is complete.\nDelivered: ${items.length} media item${items.length !== 1 ? 's' : ''}.`,
        ).catch(() => {});
      }
    }

    if (reminderDayKey === dayKey && subscription.reminder2DaySentFor !== expiresDayKey) {
      subscription.reminder2DaySentFor = expiresDayKey;
      await user.save();
      reminderUsers += 1;
      await sendQueuedMessage(
        bot.telegram,
        user.telegramId,
        `⏰ Your ${subscription.packageName} subscription expires in 2 days.\nExpiry date: ${formatISTDate(expiresAt)}.\nRenew early so you do not miss your daily media deliveries.`,
      ).catch(() => {});
    }

    if (expiresDayKey === dayKey && subscription.finalNoticeSentFor !== expiresDayKey) {
      subscription.finalNoticeSentFor = expiresDayKey;
      await user.save();
      finalNoticeUsers += 1;
      await sendQueuedMessage(
        bot.telegram,
        user.telegramId,
        `⚠️ Final notice: your ${subscription.packageName} subscription expires today.\nExpiry date: ${formatISTDate(expiresAt)}.\nRenew now to keep your daily media delivery active.`,
      ).catch(() => {});
    }
  }

  await User.updateMany(
    { 'subscription.expiresAt': { $lt: dayStart } },
    { $set: { subscription: null } }
  );

  return { dayKey, deliveredUsers, reminderUsers, finalNoticeUsers };
}

async function runDailySubscriptionCycleIfNeeded(bot, date = new Date()) {
  const dayKey = getISTDateKey(date);
  const lastRunDayKey = await Settings.get('subscriptionCycleLastRunDayKey');
  if (lastRunDayKey === dayKey) {
    return null;
  }

  const result = await processDailySubscriptions(bot, date);
  await Settings.set('subscriptionCycleLastRunDayKey', dayKey);
  return result;
}

function buildSubscriptionConfirmation(subscription) {
  return (
    `✅ Subscription confirmed!\n\n` +
    `Plan: ${subscription.packageName}\n` +
    `Plan details: ${getSubscriptionDurationText(subscription)} / ${subscription.dailyMediaCount} 🎬 per day\n` +
    `Starts delivering: ${formatISTDateTime(subscription.deliveryStartsAt)}\n` +
    `Expires: ${formatISTDateTime(subscription.expiresAt)}`
  );
}

module.exports = {
  activateSubscription,
  hasActiveSubscription,
  buildSubscriptionSummary,
  buildSubscriptionConfirmation,
  getSubscriptionDurationText,
  processDailySubscriptions,
  runDailySubscriptionCycleIfNeeded,
};
