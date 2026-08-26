const mongoose = require('mongoose');
const crypto = require('crypto');

const orderSchema = new mongoose.Schema({
  userId:          { type: Number, required: true, index: true },
  chatId:          { type: Number, required: true },
  packageId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
  amount:          { type: Number, required: true },
  mediaCount:      { type: Number, required: true },
  packageName:     { type: String, default: 'Media Pack' },
  paymentLinkMsgId: { type: Number, default: null },
  paymentToken:    { type: String, required: true, unique: true, index: true, default: () => crypto.randomBytes(5).toString('hex') },
  createdAt:       { type: Date, default: Date.now, expires: '1h' },
});

orderSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
