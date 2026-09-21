const mongoose = require('mongoose');

const sourceSchema = new mongoose.Schema(
  {
    channel_id: { type: String, required: true },
    message_id: { type: Number, required: true },
  },
  { _id: false }
);

const metadataSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['video', 'photo', 'document'], default: 'video' },
    mime_type: { type: String, default: '' },
    file_name: { type: String, default: '' },
    file_size: { type: Number, default: 0 },
    uploaded_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const mtprotoSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: ['document', 'photo'] },
    id: { type: String, required: true },
    access_hash: { type: String, required: true },
    file_reference: { type: String, default: '' },
    dc_id: { type: Number, default: 0 },
  },
  { _id: false }
);

const mediaSchema = new mongoose.Schema(
  {
    source: { type: sourceSchema, required: true },
    metadata: { type: metadataSchema, default: () => ({}) },
    bot_file_ids: { type: mongoose.Schema.Types.Mixed, default: {} },
    file_unique_id: { type: String, default: undefined },
    mtproto: { type: mtprotoSchema, default: null },
    last_seen_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

mediaSchema.index({ 'source.channel_id': 1, 'source.message_id': 1 }, { unique: true });
mediaSchema.index({ file_unique_id: 1 }, { unique: true, sparse: true });
mediaSchema.index({ 'mtproto.id': 1 }, { unique: true, sparse: true });
mediaSchema.index({ 'metadata.uploaded_at': -1 });

module.exports = mongoose.model('Media', mediaSchema);
