const mongoose = require('mongoose');

const globalArticleSchema = new mongoose.Schema(
  {
    // Core content
    title:      { type: String, required: true },
    articleUrl: { type: String, required: true, unique: true, index: true },
    source:     { type: String, required: true },   // e.g. "The Guardian", "NewsAPI"
    apiSource:  {
      type: String,
      // All active API sources — extend this list when adding new integrations.
      enum: ['newsapi', 'newsapi_ai', 'webzio', 'worldnews', 'newsdata', 'thenewsapi',
             'guardian', 'nyt', 'gdelt', 'gnews', 'rss'],
      required: true,
    },
    author:      { type: String, default: '' },
    summary:     { type: String, default: '' },
    imageUrl:    { type: String, default: '' },
    publishedAt: { type: Date, index: true },

    // Category (auto-detected — politics/world platform)
    category: {
      type: String,
      enum: ['politics', 'world', 'conflict', 'diplomacy', 'economy', 'general'],
      default: 'general',
      index: true,
    },

    // Geographic origin
    country: { type: String, default: 'GLOBAL', index: true },  // ISO 3166-1 alpha-2 or 'GLOBAL'
    region: {
      type: String,
      enum: ['Americas', 'Europe', 'Asia', 'MiddleEast', 'Africa', 'Oceania', 'GLOBAL'],
      default: 'GLOBAL',
      index: true,
    },

    // OpenAI bias + quality analysis
    qualityScore:  { type: Number, min: 1, max: 10, default: 5 },
    qualityNote:   { type: String, default: '' },
    biasLevel:     { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    biasDirection: {
      type: String,
      enum: ['left', 'center-left', 'center', 'center-right', 'right', 'unknown'],
      default: 'unknown',
    },
    biasNote:      { type: String, default: '' },
    processedAt:   { type: Date },
    analysisModel: { type: String, default: '' },

    // Engagement counters (atomic increments)
    views:  { type: Number, default: 0 },
    saves:  { type: Number, default: 0 },
    shares: { type: Number, default: 0 },

    // Pre-computed trending heat score (recalculated every cycle)
    heatScore:    { type: Number, default: 0, index: true },
    lastHeatCalc: { type: Date },

    // ─── Intelligence layer ──────────────────────────────────────────────────
    // Storyline threads this article belongs to (array of slugs)
    threads:           { type: [String], default: [] },
    // Market signal tags (e.g. 'oil-markets', 'defense-spending')
    marketTags:        { type: [String], default: [] },
    // Key political figures mentioned (extracted by OpenAI)
    people: [{ name: String, role: String, country: String }],
    // AI-generated 120-150 word neutral briefing
    expandedSummary:   { type: String, default: '' },
    // Whether full article text is stored in ArticleContent
    fullTextAvailable: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Compound indexes for efficient feed queries
globalArticleSchema.index({ heatScore: -1, publishedAt: -1 });
globalArticleSchema.index({ category: 1, heatScore: -1 });
globalArticleSchema.index({ category: 1, publishedAt: -1, qualityScore: -1 });
globalArticleSchema.index({ publishedAt: -1, qualityScore: -1 });
globalArticleSchema.index({ country: 1, publishedAt: -1 });
globalArticleSchema.index({ region: 1, heatScore: -1 });
globalArticleSchema.index({ country: 1, heatScore: -1 });
// Intelligence layer indexes
globalArticleSchema.index({ threads: 1, publishedAt: -1 });
globalArticleSchema.index({ marketTags: 1, publishedAt: -1 });
globalArticleSchema.index({ 'people.name': 1, publishedAt: -1 });

module.exports = mongoose.model('GlobalArticle', globalArticleSchema);
