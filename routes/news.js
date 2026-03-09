const express = require('express');
const router = express.Router();
const { OpenAI } = require('openai');
const RSSParser = require('rss-parser');
const mongoose = require('mongoose');

const { verifyToken } = require('../middleware/auth');
const { validateFeedUrl } = require('../middleware/ssrf');
const { audit } = require('../middleware/audit');
const NewsSource = require('../models/NewsSource');
const Article = require('../models/Article');
const GlobalArticle = require('../models/GlobalArticle');

const rssParser = new RSSParser({ timeout: 10000 });

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured.');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/news/sources  — list current user's saved feed sources
// ────────────────────────────────────────────────────────────────────────────
router.get('/sources', verifyToken, async (req, res) => {
  try {
    const sources = await NewsSource.find({ userId: req.user.id, active: true })
      .sort({ createdAt: -1 })
      .select('-__v');
    res.json(sources);
  } catch (err) {
    console.error('sources list error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/news/sources  — add a new RSS feed URL
// ────────────────────────────────────────────────────────────────────────────
router.post('/sources', verifyToken, async (req, res) => {
  try {
    let { url, label } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required.' });
    }
    url = url.trim();
    label = (label || '').trim().slice(0, 80) || url;

    // SSRF guard
    const check = await validateFeedUrl(url);
    if (!check.ok) {
      return res.status(400).json({ error: check.error });
    }

    // Enforce per-user limit of 20 active sources
    const count = await NewsSource.countDocuments({ userId: req.user.id, active: true });
    if (count >= 20) {
      return res.status(429).json({ error: 'Maximum of 20 feed sources reached.' });
    }

    const source = await NewsSource.create({
      userId:   req.user.id,
      username: req.user.username,
      url,
      label,
    });

    audit('source_added', req, {
      userId:   req.user.id,
      username: req.user.username,
      meta:     { sourceId: source._id, url, label },
    });

    res.status(201).json(source);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'You have already added this feed URL.' });
    }
    console.error('source add error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/news/sources/:id  — remove a feed source
// ────────────────────────────────────────────────────────────────────────────
router.delete('/sources/:id', verifyToken, async (req, res) => {
  try {
    const source = await NewsSource.findOne({ _id: req.params.id, userId: req.user.id });
    if (!source) return res.status(404).json({ error: 'Source not found.' });

    await NewsSource.findByIdAndUpdate(source._id, { active: false });

    audit('source_deleted', req, {
      userId:   req.user.id,
      username: req.user.username,
      meta:     { sourceId: source._id, url: source.url },
    });

    res.json({ message: 'Source removed.' });
  } catch (err) {
    console.error('source delete error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/news/fetch  — fetch + OpenAI-analyze all active sources
// ────────────────────────────────────────────────────────────────────────────
router.post('/fetch', verifyToken, async (req, res) => {
  let openai;
  try {
    openai = getOpenAI();
  } catch {
    return res.status(503).json({ error: 'OpenAI is not configured. Add OPENAI_API_KEY to .env' });
  }

  try {
    const sources = await NewsSource.find({ userId: req.user.id, active: true });
    if (!sources.length) {
      return res.json({ articles: [], message: 'No sources added yet.' });
    }

    const ARTICLES_PER_SOURCE = 10;
    const newArticles = [];

    for (const source of sources) {
      let feed;
      try {
        feed = await rssParser.parseURL(source.url);
      } catch (err) {
        console.warn(`[news] Failed to fetch ${source.url}: ${err.message}`);
        continue;
      }

      const items = feed.items.slice(0, ARTICLES_PER_SOURCE);

      for (const item of items) {
        const articleUrl = item.link || item.guid;
        if (!articleUrl) continue;

        // Skip if already analyzed for this source
        const exists = await Article.findOne({ articleUrl, sourceId: source._id }).select('_id');
        if (exists) continue;

        // Call OpenAI for quality + bias scoring
        const domain = new URL(source.url).hostname.replace(/^www\./, '');
        const rawSummary = (item.contentSnippet || item.summary || item.content || '').replace(/<[^>]+>/g, '').trim();
        const summary = rawSummary.slice(0, 400);

        let analysis = { quality: 5, qualityNote: '', biasLevel: 'medium', biasDirection: 'unknown', biasNote: '' };

        try {
          const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0,
            max_tokens: 200,
            messages: [
              {
                role: 'system',
                content: 'You are a neutral media-quality analyst. Respond ONLY with valid JSON — no markdown, no explanation.',
              },
              {
                role: 'user',
                content: `Analyze this news article:\nTitle: ${item.title}\nSource domain: ${domain}\nSummary: ${summary || '(no summary)'}\n\nRespond with exactly:\n{"quality": <integer 1-10>, "quality_note": "<one sentence>", "bias_level": "<low|medium|high>", "bias_direction": "<left|center-left|center|center-right|right|unknown>", "bias_note": "<one sentence>"}`,
              },
            ],
          });

          const raw = completion.choices[0].message.content.trim();
          const parsed = JSON.parse(raw);
          analysis = {
            quality:       Math.min(10, Math.max(1, Number(parsed.quality) || 5)),
            qualityNote:   String(parsed.quality_note  || '').slice(0, 200),
            biasLevel:     ['low', 'medium', 'high'].includes(parsed.bias_level)       ? parsed.bias_level      : 'medium',
            biasDirection: ['left', 'center-left', 'center', 'center-right', 'right', 'unknown'].includes(parsed.bias_direction) ? parsed.bias_direction : 'unknown',
            biasNote:      String(parsed.bias_note || '').slice(0, 200),
          };
        } catch (aiErr) {
          console.warn(`[news] OpenAI analysis failed for "${item.title}": ${aiErr.message}`);
        }

        try {
          const article = await Article.create({
            sourceId:      source._id,
            sourceUrl:     source.url,
            sourceLabel:   source.label,
            addedBy:       req.user.username,
            title:         (item.title || '').slice(0, 300),
            articleUrl,
            author:        item.creator || item.author || '',
            summary:       rawSummary.slice(0, 1000),
            publishedAt:   item.pubDate ? new Date(item.pubDate) : undefined,
            qualityScore:  analysis.quality,
            qualityNote:   analysis.qualityNote,
            biasLevel:     analysis.biasLevel,
            biasDirection: analysis.biasDirection,
            biasNote:      analysis.biasNote,
            processedAt:   new Date(),
            analysisModel: 'gpt-4o-mini',
          });

          newArticles.push(article);

          audit('article_saved', req, {
            userId:   req.user.id,
            username: req.user.username,
            meta:     { articleId: article._id, sourceId: source._id, qualityScore: analysis.quality, biasDirection: analysis.biasDirection },
          });
        } catch (dupErr) {
          if (dupErr.code !== 11000) console.warn('[news] Article save error:', dupErr.message);
        }
      }

      // Update source metadata
      await NewsSource.findByIdAndUpdate(source._id, {
        lastFetchedAt: new Date(),
        $inc: { articleCount: newArticles.filter((a) => String(a.sourceId) === String(source._id)).length },
      });
    }

    audit('feed_fetched', req, {
      userId:   req.user.id,
      username: req.user.username,
      meta:     { newArticles: newArticles.length, sources: sources.length },
    });

    // Return the user's full analyzed feed sorted by quality descending
    const feed = await Article.find({
      sourceId: { $in: sources.map((s) => s._id) },
    })
      .sort({ qualityScore: -1, publishedAt: -1 })
      .limit(100)
      .select('-__v');

    res.json({ articles: feed, newlyFetched: newArticles.length });
  } catch (err) {
    console.error('feed fetch error:', err.message);
    res.status(500).json({ error: 'Server error during feed fetch.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/news/feed  — return cached analyzed articles (no re-fetch)
// ────────────────────────────────────────────────────────────────────────────
router.get('/feed', verifyToken, async (req, res) => {
  try {
    const sources = await NewsSource.find({ userId: req.user.id, active: true }).select('_id');
    const feed = await Article.find({
      sourceId: { $in: sources.map((s) => s._id) },
    })
      .sort({ qualityScore: -1, publishedAt: -1 })
      .limit(100)
      .select('-__v');

    res.json({ articles: feed });
  } catch (err) {
    console.error('feed get error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ============================================================================
// PUBLIC GLOBAL FEED ENDPOINTS (no authentication required)
// ============================================================================

const VALID_CATEGORIES = new Set([
  'politics', 'world', 'conflict', 'diplomacy', 'economy', 'general',
]);
const VALID_REGIONS = new Set(['Americas', 'Europe', 'Asia', 'MiddleEast', 'Africa', 'Oceania']);
const VALID_SORTS = new Set(['trending', 'latest', 'quality', 'balanced']);
const BIAS_DIRECTION_GROUPS = {
  left:   ['left', 'center-left'],
  center: ['center'],
  right:  ['center-right', 'right'],
};

// ────────────────────────────────────────────────────────────────────────────
// GET /api/news/global
//   ?category=all|technology|politics|...
//   &sort=trending|latest|quality|balanced
//   &page=1&limit=20
// ────────────────────────────────────────────────────────────────────────────
router.get('/global', async (req, res) => {
  try {
    const category = VALID_CATEGORIES.has(req.query.category) ? req.query.category : null;
    const region   = VALID_REGIONS.has(req.query.region)     ? req.query.region   : null;
    // Legacy: front-end sends 'country' param for region filter
    const regionParam = region || (VALID_REGIONS.has(req.query.country) ? req.query.country : null);
    const sort     = VALID_SORTS.has(req.query.sort) ? req.query.sort : 'trending';
    const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit    = Math.min(40, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip     = (page - 1) * limit;

    const biasGroup = Object.prototype.hasOwnProperty.call(BIAS_DIRECTION_GROUPS, req.query.bias)
      ? req.query.bias : null;

    const query = {};
    if (category)    query.category     = category;
    if (regionParam) query.region       = regionParam;
    if (biasGroup)   query.biasDirection = { $in: BIAS_DIRECTION_GROUPS[biasGroup] };

    let sortObj;
    switch (sort) {
      case 'latest':   sortObj = { publishedAt: -1 }; break;
      case 'quality':  sortObj = { qualityScore: -1, publishedAt: -1 }; break;
      case 'balanced': sortObj = { biasLevel: 1, heatScore: -1 }; break;
      default:         sortObj = { heatScore: -1, publishedAt: -1 };
    }

    const [articles, total] = await Promise.all([
      GlobalArticle.find(query).sort(sortObj).skip(skip).limit(limit).select('-__v').lean(),
      GlobalArticle.countDocuments(query),
    ]);

    res.json({ articles, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('global feed error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/news/trending  — top 10 trending articles (public)
// ────────────────────────────────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    const articles = await GlobalArticle.find({
      publishedAt: { $gte: new Date(Date.now() - 48 * 3_600_000) },
    })
      .sort({ heatScore: -1, publishedAt: -1 })
      .limit(10)
      .select('title articleUrl source category country region biasDirection biasLevel qualityScore publishedAt heatScore summary imageUrl')
      .lean();

    res.json({ articles });
  } catch (err) {
    console.error('trending error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/news/hero  — single top featured article (public)
// ────────────────────────────────────────────────────────────────────────────
router.get('/hero', async (req, res) => {
  try {
    const article = await GlobalArticle.findOne({
      publishedAt: { $gte: new Date(Date.now() - 24 * 3_600_000) },
      qualityScore: { $gte: 7 },
    })
      .sort({ heatScore: -1 })
      .select('-__v')
      .lean();

    res.json({ article: article || null });
  } catch (err) {
    console.error('hero error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/news/stats  — feed statistics for diversity widget (public)
// ────────────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const [biasBreakdown, categoryBreakdown, total] = await Promise.all([
      GlobalArticle.aggregate([
        { $match: { publishedAt: { $gte: since } } },
        { $group: { _id: '$biasDirection', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      GlobalArticle.aggregate([
        { $match: { publishedAt: { $gte: since } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      GlobalArticle.countDocuments({ publishedAt: { $gte: since } }),
    ]);

    res.json({ biasBreakdown, categoryBreakdown, total });
  } catch (err) {
    console.error('stats error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/news/global/:id/engage  — track view/save/share (public)
//   body: { action: 'view' | 'save' | 'share' }
// ────────────────────────────────────────────────────────────────────────────
router.post('/global/:id/engage', async (req, res) => {
  const VALID_ACTIONS = new Set(['view', 'save', 'share']);
  const action = req.body?.action;

  if (!VALID_ACTIONS.has(action)) {
    return res.status(400).json({ error: 'Invalid action. Use view, save, or share.' });
  }
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: 'Article not found.' });
  }

  try {
    const field = `${action}s`; // views, saves, shares
    const article = await GlobalArticle.findByIdAndUpdate(
      req.params.id,
      { $inc: { [field]: 1 } },
      { new: true, select: 'views saves shares heatScore' }
    );
    if (!article) return res.status(404).json({ error: 'Article not found.' });

    // Recompute heat score inline
    const { calcHeatScore } = require('../server/newsAggregator');
    const heat = calcHeatScore(article);
    await GlobalArticle.findByIdAndUpdate(article._id, { heatScore: heat, lastHeatCalc: new Date() });

    res.json({ ok: true });
  } catch (err) {
    console.error('engage error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/news/recommended  — personalized feed (auth required)
//   Returns high-quality articles in categories similar to the user's
//   recently-saved/viewed articles (simple topic-affinity approach).
// ────────────────────────────────────────────────────────────────────────────
router.get('/recommended', verifyToken, async (req, res) => {
  try {
    // For now: recommend top-quality articles across categories the user hasn't seen yet
    // A full embedding-based engine can be layered on top later
    const articles = await GlobalArticle.find({
      publishedAt: { $gte: new Date(Date.now() - 48 * 3_600_000) },
      qualityScore: { $gte: 7 },
      biasLevel: { $in: ['low', 'medium'] },
    })
      .sort({ qualityScore: -1, heatScore: -1 })
      .limit(8)
      .select('title articleUrl source category biasDirection biasLevel qualityScore publishedAt summary imageUrl biasNote')
      .lean();

    res.json({ articles });
  } catch (err) {
    console.error('recommended error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;

