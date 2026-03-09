'use strict';
const mongoose = require('mongoose');

const personSchema = new mongoose.Schema(
  {
    canonicalName:   { type: String, required: true },
    slug:            { type: String, required: true, unique: true },
    aliases:         { type: [String], default: [] },
    role:            { type: String, default: '' },
    country:         { type: String, default: '' },
    articleCount:    { type: Number, default: 0 },
    articleCount24h: { type: Number, default: 0 },
    articleCount7d:  { type: Number, default: 0 },
    isTracked:       { type: Boolean, default: false },
  },
  { timestamps: true }
);

personSchema.index({ articleCount7d: -1 });
personSchema.index({ isTracked: 1, articleCount7d: -1 });

module.exports = mongoose.model('Person', personSchema);
