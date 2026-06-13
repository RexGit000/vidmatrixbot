const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema({
  // One of these must be set; username-only admins get telegramId filled in when they first interact
  telegramId:   { type: Number, default: null },
  username:     { type: String, default: null }, // Always stored with @ prefix
  isSuperAdmin: { type: Boolean, default: false },
  addedBy:      { type: Number, default: null }, // telegramId of admin who added this one
  createdAt:    { type: Date, default: Date.now },
});

adminSchema.index({ telegramId: 1 }, { sparse: true });
adminSchema.index({ username: 1 },   { sparse: true });

module.exports = mongoose.model('Admin', adminSchema);
