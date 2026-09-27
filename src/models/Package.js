const mongoose = require('mongoose');

const packageSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  stars:      { type: Number, required: true },
  mediaCount: { type: Number, required: true },
  isActive:   { type: Boolean, default: true },
  order:      { type: Number, default: 0 },
});

module.exports = mongoose.model('Package', packageSchema);
