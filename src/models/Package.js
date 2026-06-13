const mongoose = require('mongoose');

const packageSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  stars:      { type: Number, required: true },
  mediaCount: { type: Number, required: true },
  type:       { type: String, enum: ['one_time', 'subscription'], default: 'one_time', index: true },
  dailyMediaCount: { type: Number, default: 0 },
  durationDays: { type: Number, default: 0 },
  durationMonths: { type: Number, default: 0 },
  perks: { type: [String], default: [] },
  isActive:   { type: Boolean, default: true },
  order:      { type: Number, default: 0 },
});

module.exports = mongoose.model('Package', packageSchema);
