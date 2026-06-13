const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true, index: true },
  username:   { type: String, default: null },
  firstName:  { type: String, default: '' },
  lastName:   { type: String, default: '' },
  referrerId: { type: Number, default: null },
  inviteCount:  { type: Number, default: 0 },
  points:        { type: Number, default: 0 },
  receivedMedia: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Media' }],
  referralEvents: {
    type: [{
      referredUserId: { type: Number, required: true },
      joinedAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
  claimedTiers:  { type: [String], default: [] },
  subscription: {
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
    packageName: { type: String, default: '' },
    stars: { type: Number, default: 0 },
    dailyMediaCount: { type: Number, default: 0 },
    durationDays: { type: Number, default: 0 },
    durationMonths: { type: Number, default: 0 },
    perks: { type: [String], default: [] },
    deliveryStartsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    lastDeliveredDayKey: { type: String, default: null },
    reminder2DaySentFor: { type: String, default: null },
    finalNoticeSentFor: { type: String, default: null },
    purchasedAt: { type: Date, default: null },
  },
  viewMode: { type: String, enum: ['user', 'admin'], default: 'user' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
