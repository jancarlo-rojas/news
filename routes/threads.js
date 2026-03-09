'use strict';
const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');
const { OpenAI } = require('openai');

const Thread        = require('../models/Thread');
const GlobalArticle = require('../models/GlobalArticle');
const ArticleContent = require('../models/ArticleContent');
const UserThread    = require('../models/UserThread');
const Person        = require('../models/Person');

// Auth middleware (optional  only used on protected routes)
const { verifyToken } = require('../middleware/auth');

//  GET /api/threads  list active threads sorted by heat (pinned first) 
// Only returns threads that have at least one article  never shows empty categories.
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const threads = await Thread.find({ isActive: true, articleCount: { $gt: 0 } })
      .sort({ isPinned: -1, heatScore: -1 })
      .limit(limit)
      .lean();
    res.json({ threads });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load threads' });
  }
});

//  GET /api/threads/active-regions  regions that have 1 active thread 
// Used by the frontend to hide empty region tabs dynamically.
router.get('/active-regions', async (req, res) => {
  try {
    const regions = await Thread.distinct('region', { isActive: true, articleCount: { $gt: 0 } });
    res.json({ regions: regions.filter(Boolean).sort() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load regions' });
  }
});

//  GET /api/threads/followed  user's followed threads 
// MUST be before /:slug route
router.get('/followed', verifyToken, async (req, res) => {
  try {
    const follows = await UserThread.find({ userId: req.user._id }).lean();
    if (!follows.length) return res.json({ threads: [] });
    const slugs = follows.map((f) => f.threadSlug);
    const threads = await Thread.find({ slug: { $in: slugs } })
      .sort({ heatScore: -1 })
      .lean();
    res.json({ threads });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load followed threads' });
  }
});

//  GET /api/threads/for-you  personalized feed 
router.get('/for-you', verifyToken, async (req, res) => {
  try {
    const follows = await UserThread.find({ userId: req.user._id }).lean();
    let articles;
    if (follows.length) {
      const slugs = follows.map((f) => f.threadSlug);
      articles = await GlobalArticle.find({ threads: { $in: slugs } })
        .sort({ heatScore: -1, publishedAt: -1 })
        .limit(40)
        .lean();
    } else {
      // Fallback: high-quality articles
      articles = await GlobalArticle.find({ qualityScore: { $gte: 7 } })
        .sort({ heatScore: -1, publishedAt: -1 })
        .limit(40)
        .lean();
    }
    res.json({ articles });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load for-you feed' });
  }
});

//  GET /api/threads/people  top people by 7-day count 
router.get('/people', async (req, res) => {
  try {
    const people = await Person.find()
      .sort({ articleCount7d: -1 })
      .limit(12)
      .lean();
    res.json({ people });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load people' });
  }
});

const VALID_MARKET_TAGS = new Set([
  'oil-markets', 'defense-spending', 'sanctions-trade', 'currency-wars',
  'commodity-prices', 'central-bank-policy', 'tech-regulation', 'debt-crisis',
]);

//  GET /api/threads/market-tags  all market tags with counts 
router.get('/market-tags', async (req, res) => {
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const agg = await GlobalArticle.aggregate([
      { $match: { publishedAt: { $gte: since7d }, marketTags: { $exists: true, $not: { $size: 0 } } } },
      { $unwind: '$marketTags' },
      { $group: { _id: '$marketTags', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    res.json({ tags: agg.map((a) => ({ tag: a._id, count: a.count })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load market tags' });
  }
});

//  GET /api/threads/market-tags/:tag/articles 
router.get('/market-tags/:tag/articles', async (req, res) => {
  try {
    const tag = String(req.params.tag).replace(/[^a-z0-9-]/gi, '').slice(0, 60);
    if (!VALID_MARKET_TAGS.has(tag)) {
      return res.status(400).json({ error: 'Invalid market tag' });
    }
    const SORT_MAP = { trending: { heatScore: -1 }, quality: { qualityScore: -1 }, latest: { publishedAt: -1 } };
    const sortKey = SORT_MAP[String(req.query.sort)] || SORT_MAP.latest;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const page  = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip  = (page - 1) * limit;
    const articles = await GlobalArticle.find({ marketTags: tag })
      .sort(sortKey)
      .skip(skip)
      .limit(limit)
      .lean();
    res.json({ articles, page, limit });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load market tag articles' });
  }
});

//  GET /api/threads/market-tags/:tag/threads 
// Returns storyline threads that contain articles tagged with this market signal.
router.get('/market-tags/:tag/threads', async (req, res) => {
  try {
    const tag = String(req.params.tag).replace(/[^a-z0-9-]/gi, '').slice(0, 60);
    if (!VALID_MARKET_TAGS.has(tag)) {
      return res.status(400).json({ error: 'Invalid market tag' });
    }
    const agg = await GlobalArticle.aggregate([
      { $match: { marketTags: tag } },
      { $unwind: '$threads' },
      { $group: { _id: '$threads' } },
    ]);
    const slugs = agg.map((a) => a._id).filter(Boolean);
    const threads = await Thread.find({
      slug: { $in: slugs },
      isActive: true,
      articleCount: { $gt: 0 },
    })
      .sort({ heatScore: -1 })
      .lean();
    res.json({ tag, threads });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load market tag threads' });
  }
});

//  GET /api/threads/people/:slug/articles 
router.get('/people/:slug/articles', async (req, res) => {
  try {
    const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    const person = await Person.findOne({ slug }).lean();
    if (!person) return res.status(404).json({ error: 'Person not found' });
    const articles = await GlobalArticle.find({ 'people.name': person.canonicalName })
      .sort({ publishedAt: -1 })
      .limit(20)
      .lean();
    res.json({ person, articles });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load person articles' });
  }
});

//  GET /api/threads/article-content/:id 
router.get('/article-content/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    const content = await ArticleContent.findOne({ articleId: req.params.id }).lean();
    if (!content) return res.status(404).json({ error: 'Not found' });
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load article content' });
  }
});

//  GET /api/threads/:slug  thread detail 
router.get('/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    const thread = await Thread.findOne({ slug, isActive: true }).lean();
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [biasBreakdown, keyPeople, marketTagAgg] = await Promise.all([
      GlobalArticle.aggregate([
        { $match: { threads: slug, publishedAt: { $gte: since7d } } },
        { $group: { _id: '$biasDirection', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      GlobalArticle.aggregate([
        { $match: { threads: slug, 'people.0': { $exists: true } } },
        { $unwind: '$people' },
        { $group: { _id: '$people.name', role: { $first: '$people.role' }, country: { $first: '$people.country' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      GlobalArticle.aggregate([
        { $match: { threads: slug, marketTags: { $exists: true, $not: { $size: 0 } } } },
        { $unwind: '$marketTags' },
        { $group: { _id: '$marketTags', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
    ]);

    res.json({ thread, biasBreakdown, keyPeople, marketTags: marketTagAgg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

//  GET /api/threads/:slug/articles 
router.get('/:slug/articles', async (req, res) => {
  try {
    const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const sort  = req.query.sort || 'latest';
    const skip  = (page - 1) * limit;

    const sortMap = {
      latest:   { publishedAt: -1 },
      trending: { heatScore: -1, publishedAt: -1 },
      quality:  { qualityScore: -1, publishedAt: -1 },
    };
    const sortObj = sortMap[sort] || sortMap.latest;

    const [articles, total] = await Promise.all([
      GlobalArticle.find({ threads: slug }).sort(sortObj).skip(skip).limit(limit).lean(),
      GlobalArticle.countDocuments({ threads: slug }),
    ]);

    res.json({ articles, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load thread articles' });
  }
});

//  GET /api/threads/:slug/context  lazy AI context briefing 
router.get('/:slug/context', async (req, res) => {
  try {
    const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    const thread = await Thread.findOne({ slug }).lean();
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    // Return cached if fresh (< 7 days)
    const cacheAge = thread.contextGeneratedAt
      ? Date.now() - new Date(thread.contextGeneratedAt).getTime()
      : Infinity;
    if (thread.contextBriefing && cacheAge < 7 * 24 * 60 * 60 * 1000) {
      return res.json({ contextBriefing: thread.contextBriefing, cached: true });
    }

    // Generate with OpenAI
    if (!process.env.OPENAI_API_KEY) {
      return res.json({ contextBriefing: thread.description || '', cached: false });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const recent = await GlobalArticle.find({ threads: slug })
      .sort({ publishedAt: -1 })
      .limit(5)
      .select('title summary')
      .lean();
    const headlines = recent.map((a) => `- ${a.title}`).join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'You are a neutral political analyst. Write a 3-sentence context briefing for a news storyline, covering its background, current status, and why it matters. Be factual, concise and impartial.' },
        { role: 'user', content: `Storyline: "${thread.name}"\nRecent headlines:\n${headlines}\n\nWrite the context briefing.` },
      ],
    });

    const briefing = completion.choices[0]?.message?.content?.trim() || thread.description;
    await Thread.updateOne({ slug }, { $set: { contextBriefing: briefing, contextGeneratedAt: new Date() } });
    res.json({ contextBriefing: briefing, cached: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate context' });
  }
});

//  POST /api/threads/:slug/follow 
router.post('/:slug/follow', verifyToken, async (req, res) => {
  try {
    const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    await UserThread.updateOne(
      { userId: req.user._id, threadSlug: slug },
      { $setOnInsert: { userId: req.user._id, threadSlug: slug } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to follow thread' });
  }
});

//  DELETE /api/threads/:slug/follow 
router.delete('/:slug/follow', verifyToken, async (req, res) => {
  try {
    const slug = String(req.params.slug).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    await UserThread.deleteOne({ userId: req.user._id, threadSlug: slug });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unfollow thread' });
  }
});

module.exports = router;
