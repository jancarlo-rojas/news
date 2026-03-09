const mongoose = require('mongoose');

const newsSourceSchema = new mongoose.Schema(
  {
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    username: { type: String, required: true },
    url:      { type: String, required: true, trim: true },
    label:    { type: String, required: true, trim: true, maxlength: 80 },
    active:   { type: Boolean, default: true },
    lastFetchedAt: { type: Date },
    articleCount:  { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One user cannot add the same feed URL twice
newsSourceSchema.index({ userId: 1, url: 1 }, { unique: true });

module.exports = mongoose.model('NewsSource', newsSourceSchema);
