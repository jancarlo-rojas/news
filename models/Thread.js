'use strict';
const mongoose = require('mongoose');

const threadSchema = new mongoose.Schema(
  {
    name:            { type: String, required: true },
    slug:            { type: String, required: true, unique: true },
    icon:            { type: String, default: '📰' },
    color:           { type: String, default: '#6B7280' },
    description:     { type: String, default: '' },
    parentCategory:  { type: String, default: 'world' },
    region:          { type: String, default: '' },
    isPinned:        { type: Boolean, default: false },
    isActive:        { type: Boolean, default: true },
    autoSpawned:     { type: Boolean, default: false },
    relatedKeywords: { type: [String], default: [] },
    excludeKeywords: { type: [String], default: [] },
    relatedCountries:{ type: [String], default: [] },
    relatedPeople:   { type: [String], default: [] },
    articleCount:    { type: Number, default: 0 },
    articleCount24h: { type: Number, default: 0 },
    articleCount7d:  { type: Number, default: 0 },
    lastActivity:    { type: Date },
    heatScore:       { type: Number, default: 0 },
    contextBriefing:      { type: String, default: '' },
    contextGeneratedAt:   { type: Date },
  },
  { timestamps: true }
);

threadSchema.index({ heatScore: -1, isActive: 1 });
threadSchema.index({ isPinned: -1, heatScore: -1 });

module.exports = mongoose.model('Thread', threadSchema);
