'use strict';
const mongoose = require('mongoose');

const articleContentSchema = new mongoose.Schema(
  {
    articleId:       { type: mongoose.Schema.Types.ObjectId, ref: 'GlobalArticle', required: true, unique: true },
    articleUrl:      { type: String, default: '' },
    source:          { type: String, default: '' },
    fullTextHtml:    { type: String, default: '' },
    fullTextPlain:   { type: String, default: '' },
    wordCount:       { type: Number, default: 0 },
    expandedSummary: { type: String, default: '' },
    keyPoints:       { type: [String], default: [] },
    readingTimeMinutes: { type: Number, default: 1 },
    // guardian-api | nyt-api | rss | ai-summary
    extractionMethod:{ type: String, default: 'ai-summary' },
    extractedAt:     { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ArticleContent', articleContentSchema);
