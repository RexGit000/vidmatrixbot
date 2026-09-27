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
  claimedTiers:  { type: [String], default: [] },
  viewMode: { type: String, enum: ['user', 'admin'], default: 'user' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('User', userSchema);
