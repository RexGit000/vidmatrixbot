const mongoose = require('mongoose');

const mediaSchema = new mongoose.Schema({
  fileId:           { type: String, required: true, index: true },
  fileType:         { type: String, enum: ['photo', 'video'], required: true },
  channelMessageId: { type: Number, default: null },
  channelId:        { type: String, default: null },
  addedAt:          { type: Date, default: Date.now },
});

module.exports = mongoose.model('Media', mediaSchema);
