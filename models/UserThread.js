'use strict';
const mongoose = require('mongoose');

const userThreadSchema = new mongoose.Schema(
  {
    userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    threadSlug:      { type: String, required: true },
    notifyBreaking:  { type: Boolean, default: false },
  },
  { timestamps: true }
);

userThreadSchema.index({ userId: 1, threadSlug: 1 }, { unique: true });

module.exports = mongoose.model('UserThread', userThreadSchema);
