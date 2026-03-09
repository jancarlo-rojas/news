const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema(
  {
    // Provenance
    sourceId:  { type: mongoose.Schema.Types.ObjectId, ref: 'NewsSource', required: true, index: true },
    sourceUrl: { type: String, required: true },
    sourceLabel: { type: String },
    addedBy:   { type: String, required: true },   // username

    // Article content
    title:       { type: String, required: true },
    articleUrl:  { type: String, required: true },  // deduplicated
    author:      { type: String },
    summary:     { type: String },                  // from RSS description
    publishedAt: { type: Date },

    // OpenAI analysis
    qualityScore:     { type: Number, min: 1, max: 10 },
    qualityNote:      { type: String },
    biasLevel:        { type: String, enum: ['low', 'medium', 'high'] },
    biasDirection:    { type: String, enum: ['left', 'center-left', 'center', 'center-right', 'right', 'unknown'] },
    biasNote:         { type: String },
    processedAt:      { type: Date },
    analysisModel:    { type: String },             // e.g. gpt-4o-mini
  },
  { timestamps: true }
);

// Deduplicate by article URL — a given article is analyzed once per source owner
articleSchema.index({ articleUrl: 1, sourceId: 1 }, { unique: true });

module.exports = mongoose.model('Article', articleSchema);
