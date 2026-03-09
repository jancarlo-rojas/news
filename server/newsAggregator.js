'use strict';
/**
 * News Aggregator — background job that pulls articles from multiple APIs,
 * runs OpenAI bias + quality analysis, and populates the GlobalArticle collection.
 *
 * Sources (all REST APIs — no RSS feeds):
 *   - NewsAPI.org          (env: NEWSAPI_KEY)
 *   - NewsAPI.ai           (env: NEWSAPI_AI_KEY)
 *   - Webz.io Lite         (env: WEBZ_KEY)
 *   - WorldNewsAPI.com     (env: WORLDNEWS_KEY)
 *   - NewsData.io          (env: NEWSDATA_KEY)
 *   - TheNewsAPI.com       (env: THENEWSAPI_KEY)
 *
 * Focus: Politics, world events, war, conflict, diplomacy, and geopolitical economics.
 * Entertainment, sports, and lifestyle content is filtered out automatically.
 *
 * Runs immediately on startup, then every 15 minutes.
 */

const https        = require('https');
const { OpenAI }   = require('openai');
const GlobalArticle  = require('../models/GlobalArticle');
const ArticleContent = require('../models/ArticleContent');
const Thread         = require('../models/Thread');
const Person         = require('../models/Person');
const { assignThreadsKeyword, detectMarketTags } = require('./threads/threadKeywordMap');

// ─── OpenAI helper ───────────────────────────────────────────────────────────
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Secure HTTPS fetch ──────────────────────────────────────────────────────
// Only HTTPS, only to well-known public hostnames (all hardcoded below).
// extraHeaders: optional object of additional request headers (e.g. User-Agent).
function fetchJSON(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }

    if (parsed.protocol !== 'https:') {
      return reject(new Error('Only HTTPS URLs are allowed'));
    }

    // Block private/loopback ranges (defense-in-depth, URLs are hardcoded)
    const h = parsed.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) {
      return reject(new Error('Private addresses blocked'));
    }

    const req = https.get(url, { timeout: 12000, headers: extraHeaders }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error('Response too large')); }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Rate-limit guards (module-scoped, survives across cycles) ───────────────
// Free API tiers have strict daily/monthly call limits — these guards prevent
// 429 errors by enforcing a minimum re-fetch interval per source.
const _lastFetch = {};
function guardedFetch(sourceKey, minIntervalMs) {
  const now = Date.now();
  if (_lastFetch[sourceKey] && (now - _lastFetch[sourceKey]) < minIntervalMs) {
    const waitMin = Math.ceil((minIntervalMs - (now - _lastFetch[sourceKey])) / 60000);
    console.log(`[aggregator] ${sourceKey}: skipped — rate-limit window (${waitMin}m remaining)`);
    return false;
  }
  _lastFetch[sourceKey] = now;
  return true;
}

// ─── Pure-entertainment / tabloid blocklist ──────────────────────────────────
// Drop domains that publish zero politics/war/economics content. Major news
// outlets (BBC, CNN, NYT, Fox, Guardian, AP, Reuters, etc.) are intentionally
// NOT blocked — they cover real geopolitical events and the bias classifier
// will flag editorial lean so readers stay media-literate.
const MAINSTREAM_DOMAINS = new Set([
  // Pure celebrity / entertainment
  'tmz.com', 'people.com', 'perezhilton.com', 'ew.com',
  'vanityfair.com', 'rollingstone.com',
  // Tabloid clickbait
  'dailymail.co.uk', 'mirror.co.uk', 'thesun.co.uk', 'nydailynews.com',
  // Lifestyle / listicle
  'buzzfeed.com', 'buzzfeednews.com', 'huffpost.com',
]);

function isMainstreamMedia(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return MAINSTREAM_DOMAINS.has(host);
  } catch { return false; }
}

// ─── Category detection (keyword matching) ───────────────────────────────────
// ─── Relevance gate ───────────────────────────────────────────────────────────
const IRRELEVANT_SIGNALS = [
  'crossword', 'wordle', 'sudoku', 'trivia quiz',
  'nfl ', 'nba ', 'nhl ', 'mlb ', 'nascar', 'wnba', 'espn',
  'premier league', 'champions league', 'europa league', 'la liga', 'serie a',
  'bundesliga', 'ligue 1', 'formula 1', 'f1 driver', 'grand prix',
  'super bowl', 'world series', 'stanley cup',
  'olympic medal', 'olympic games', 'winter olympics', 'summer olympics',
  'academy award', 'grammy award', 'emmy award', 'bafta award', 'golden globe',
  'box office', 'movie review', 'film review', 'album release',
  'concert tour', 'celebrity gossip', 'red carpet', 'fashion week', 'met gala',
  'reality tv', 'reality show',
  'horoscope', 'cooking recipe', 'restaurant review', 'travel guide',
  'video game review', 'esports tournament',
];

function isRelevant(title, summary) {
  // Pad with spaces so signals like 'nfl ' match even at end-of-string
  const text = ` ${title} ${summary} `.toLowerCase();
  return !IRRELEVANT_SIGNALS.some((signal) => text.includes(signal));
}

// ─── Category detection (politics-focused platform) ──────────────────────────
const CATEGORY_KEYWORDS = {
  conflict: [
    'war', 'invasion', 'airstrike', 'ceasefire', 'missile', 'bomb', 'troops',
    'military offensive', 'frontline', 'battle', 'military strike', 'naval',
    'drone attack', 'shelling', 'artillery', 'combat', 'insurgent',
    'terrorism', 'terrorist attack', 'civilian casualties', 'siege', 'occupation',
    'guerrilla', 'revolution', 'uprising', 'insurgency', 'armed forces',
    'military operation', 'warzone', 'ground offensive',
  ],
  diplomacy: [
    'diplomat', 'ambassador', 'embassy', 'treaty', 'bilateral', 'multilateral',
    'summit', 'negotiation', 'foreign minister', 'secretary of state',
    'international law', 'peace talks', 'foreign policy', 'geopolitic',
    'international relations', 'trade agreement', 'diplomatic ties',
    'expel diplomat', 'ceasefire agreement', 'un resolution', 'peacekeeping mission',
  ],
  politics: [
    'president', 'prime minister', 'congress', 'senate',
    'parliament', 'election', 'vote', 'ballot', 'democrat', 'republican',
    'government', 'policy', 'legislation', 'politician', 'supreme court',
    'white house', 'minister', 'administration', 'political', 'gop',
    'campaign', 'referendum', 'impeach', 'cabinet', 'chancellor',
    'constitutional', 'inauguration', 'veto', 'executive order', 'bipartisan',
  ],
  economy: [
    'trade war', 'tariff', 'embargo', 'gdp', 'inflation',
    'recession', 'central bank', 'federal reserve', 'sovereign debt',
    'currency crisis', 'oil price', 'energy crisis', 'supply chain',
    'economic warfare', 'export ban', 'nationalization', 'petrodollar',
    'debt default', 'fiscal policy', 'monetary policy', 'economic sanctions',
  ],
  world: [
    'international', 'global', 'foreign', 'immigration', 'refugee',
    'border crisis', 'humanitarian crisis', 'world leaders', 'g20', 'g7',
    'united nations', 'nuclear', 'occupied territory', 'sovereignty',
    'autonomy', 'geopolitical', 'trans-atlantic', 'asia-pacific',
  ],
};

function detectCategory(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  let best = 'general', bestScore = 0;
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    const score = kws.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

// ─── Country detection ────────────────────────────────────────────────────────
const COUNTRY_KEYWORDS = {
  US: ['united states', 'american', 'washington d.c.', 'white house', 'pentagon',
       'congress', 'u.s. military', 'trump', 'biden', 'federal reserve',
       'state department', 'cia', 'fbi', 'u.s. senate', 'u.s. house'],
  CA: ['canada', 'canadian', 'ottawa', 'trudeau', 'montreal', 'toronto', 'carney'],
  MX: ['mexico', 'mexican', 'mexico city', 'cartel', 'claudia sheinbaum', 'pemex'],
  BR: ['brazil', 'brazilian', 'brasilia', 'lula', 'bolsonaro', 'amazon deforestation'],
  AR: ['argentina', 'argentinian', 'buenos aires', 'milei', 'peronism'],
  VE: ['venezuela', 'venezuelan', 'caracas', 'maduro'],
  CO: ['colombia', 'colombian', 'bogota', 'petro'],
  CU: ['cuba', 'cuban', 'havana'],
  UK: ['united kingdom', 'britain', 'british', 'london', 'downing street',
       'westminster', 'scotland', 'sunak', 'starmer', 'labour party',
       'conservative party', 'mi6'],
  DE: ['germany', 'german', 'berlin', 'bundestag', 'scholz', 'bundeswehr'],
  FR: ['france', 'french', 'paris', 'macron', 'elysee'],
  IT: ['italy', 'italian', 'rome', 'milan', 'meloni'],
  ES: ['spain', 'spanish', 'madrid', 'barcelona', 'sanchez', 'catalonia'],
  PL: ['poland', 'polish', 'warsaw', 'tusk'],
  HU: ['hungary', 'hungarian', 'budapest', 'orban'],
  GR: ['greece', 'greek', 'athens'],
  SE: ['sweden', 'swedish', 'stockholm'],
  FI: ['finland', 'finnish', 'helsinki'],
  NL: ['netherlands', 'dutch', 'amsterdam', 'the hague', 'wilders'],
  RU: ['russia', 'russian', 'moscow', 'kremlin', 'putin', 'russian military',
       'russian forces', 'russian army', 'oligarch', 'wagner'],
  UA: ['ukraine', 'ukrainian', 'kyiv', 'zelenskyy', 'zelensky', 'donbas',
       'donbass', 'kharkiv', 'zaporizhzhia', 'mariupol', 'kherson'],
  BY: ['belarus', 'belarusian', 'minsk', 'lukashenko'],
  GE: ['republic of georgia', 'tbilisi', 'georgian government'],
  AZ: ['azerbaijan', 'baku', 'nagorno-karabakh', 'aliyev'],
  AM: ['armenia', 'armenian', 'yerevan', 'pashinyan'],
  RS: ['serbia', 'serbian', 'belgrade', 'vucic'],
  IR: ['iran', 'iranian', 'tehran', 'ayatollah', 'irgc', 'revolutionary guard',
       'khamenei', 'pezeshkian', 'persian gulf'],
  IL: ['israel', 'israeli', 'tel aviv', 'netanyahu', 'idf', 'knesset', 'mossad'],
  PS: ['palestine', 'palestinian', 'hamas', 'ramallah', 'fatah',
       'gaza strip', 'west bank', 'plo'],
  SA: ['saudi arabia', 'saudi', 'riyadh', 'mbs', 'mohammed bin salman', 'aramco', 'opec'],
  TR: ['turkey', 'turkish', 'ankara', 'erdogan', 'istanbul', 'pkk'],
  SY: ['syria', 'syrian', 'damascus', 'aleppo', 'idlib'],
  IQ: ['iraq', 'iraqi', 'baghdad', 'mosul', 'erbil'],
  LB: ['lebanon', 'lebanese', 'beirut', 'hariri'],
  YE: ['yemen', 'yemeni', 'sanaa', 'houthi', 'aden'],
  AE: ['uae', 'united arab emirates', 'abu dhabi', 'dubai'],
  IN: ['india', 'indian', 'new delhi', 'modi', 'mumbai', 'kashmir', 'bjp'],
  PK: ['pakistan', 'pakistani', 'islamabad', 'imran khan', 'karachi', 'isi'],
  AF: ['afghanistan', 'afghan', 'kabul', 'taliban'],
  BD: ['bangladesh', 'bangladeshi', 'dhaka', 'yunus'],
  MM: ['myanmar', 'burma', 'burmese', 'naypyidaw', 'tatmadaw'],
  TH: ['thailand', 'thai', 'bangkok', 'thaksin'],
  ID: ['indonesia', 'indonesian', 'jakarta', 'prabowo'],
  PH: ['philippines', 'philippine', 'manila', 'marcos', 'duterte'],
  CN: ['china', 'chinese', 'beijing', 'xi jinping', 'communist party of china',
       'ccp', 'pla', 'hong kong', 'taiwan strait', 'xinjiang', 'tibet'],
  TW: ['taiwan', 'taiwanese', 'taipei', 'lai ching-te'],
  KP: ['north korea', 'north korean', 'pyongyang', 'kim jong un', 'dprk'],
  KR: ['south korea', 'south korean', 'seoul', 'korean national assembly'],
  JP: ['japan', 'japanese', 'tokyo', 'kishida', 'shigeru ishiba', 'self-defense force'],
  ZA: ['south africa', 'south african', 'pretoria', 'anc', 'ramaphosa'],
  NG: ['nigeria', 'nigerian', 'abuja', 'lagos', 'boko haram', 'tinubu'],
  ET: ['ethiopia', 'ethiopian', 'addis ababa', 'tigray', 'abiy ahmed'],
  SD: ['sudan', 'sudanese', 'khartoum', 'darfur', 'rsf'],
  LY: ['libya', 'libyan', 'tripoli', 'benghazi', 'haftar'],
  EG: ['egypt', 'egyptian', 'cairo', 'sisi', 'suez canal'],
  SO: ['somalia', 'somali', 'mogadishu', 'al-shabaab'],
  ML: ['mali', 'malian', 'bamako', 'sahel junta'],
  CD: ['congo', 'congolese', 'kinshasa', 'drc', 'm23'],
  AU: ['australia', 'australian', 'sydney', 'canberra', 'albanese'],
  NZ: ['new zealand', 'wellington', 'luxon'],
  // Note: EU articles fall back to SOURCE_COUNTRY_MAP defaults (UK/US) or 'GLOBAL'
};

const SOURCE_COUNTRY_MAP = {
  newsapi: 'US', newsapi_ai: 'GLOBAL',
  webzio: 'GLOBAL', worldnews: 'GLOBAL', newsdata: 'GLOBAL', thenewsapi: 'GLOBAL',
};

const COUNTRY_REGION_MAP = {
  US: 'Americas', CA: 'Americas', MX: 'Americas',
  BR: 'Americas', AR: 'Americas', VE: 'Americas', CO: 'Americas', CU: 'Americas',
  UK: 'Europe',   DE: 'Europe',   FR: 'Europe',   IT: 'Europe',   ES: 'Europe',
  PL: 'Europe',   HU: 'Europe',   GR: 'Europe',   SE: 'Europe',   FI: 'Europe',
  NL: 'Europe',   RU: 'Europe',   UA: 'Europe',   BY: 'Europe',   GE: 'Europe',
  AZ: 'Europe',   AM: 'Europe',   RS: 'Europe',
  CN: 'Asia',     JP: 'Asia',     KR: 'Asia',     KP: 'Asia',
  IN: 'Asia',     PK: 'Asia',     AF: 'Asia',     BD: 'Asia',
  TW: 'Asia',     MM: 'Asia',     TH: 'Asia',     ID: 'Asia',     PH: 'Asia',
  IR: 'MiddleEast', IL: 'MiddleEast', PS: 'MiddleEast', SA: 'MiddleEast',
  TR: 'MiddleEast', SY: 'MiddleEast', IQ: 'MiddleEast', LB: 'MiddleEast',
  YE: 'MiddleEast', AE: 'MiddleEast',
  ZA: 'Africa',   NG: 'Africa',   ET: 'Africa',   SD: 'Africa',
  LY: 'Africa',   EG: 'Africa',   SO: 'Africa',   ML: 'Africa',   CD: 'Africa',
  AU: 'Oceania',  NZ: 'Oceania',
};

function detectCountry(title, summary, sourceOrigin) {
  const text = `${title} ${summary}`.toLowerCase();
  let bestCode = null, bestScore = 0;
  for (const [code, keywords] of Object.entries(COUNTRY_KEYWORDS)) {
    const score = keywords.reduce((n, kw) => n + (text.includes(kw) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; bestCode = code; }
  }
  if (!bestCode || bestScore === 0) {
    bestCode = SOURCE_COUNTRY_MAP[sourceOrigin] ?? 'GLOBAL';
  }
  return bestCode;
}

function countryToRegion(code) {
  return COUNTRY_REGION_MAP[code] ?? 'GLOBAL';
}

// ─── Heat score (Hacker News gravity model) ──────────────────────────────────
function calcHeatScore(article) {
  const E = (article.views || 0) + (article.saves || 0) * 5 + (article.shares || 0) * 10;
  const hoursAgo = article.publishedAt
    ? Math.max(0, (Date.now() - new Date(article.publishedAt).getTime()) / 3_600_000)
    : 24;
  const base = (E + 5) / Math.pow(hoursAgo + 2, 1.5);
  const qualityMult = ((article.qualityScore || 5) / 10) * 0.5 + 0.5; // range 0.55–1.0
  return parseFloat((base * qualityMult).toFixed(6));
}

// ─── OpenAI — Extended analysis: bias + quality + threads + people + summary ──
async function analyzeArticle(openai, title, summary, source, keywordThreads, keywordMarketTags) {
  if (!openai) return null;
  try {
    const KNOWN_THREADS = keywordThreads.join(', ') || 'none detected by keyword';
    const KNOWN_MARKET  = keywordMarketTags.join(', ') || 'none detected by keyword';
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: 'You are a neutral political news analyst. Respond ONLY with valid JSON — no markdown, no extra text.',
        },
        {
          role: 'user',
          content:
            `Analyze this article:\nTitle: ${title}\nSource: ${source}\nSummary: ${(summary || '').slice(0, 500)}\n` +
            `Keyword-detected threads: ${KNOWN_THREADS}\n` +
            `Keyword-detected market tags: ${KNOWN_MARKET}\n\n` +
            'Respond with exactly this JSON:\n' +
            '{\n' +
            '  "quality": <integer 1-10>,\n' +
            '  "quality_note": "<one sentence>",\n' +
            '  "bias_level": "<low|medium|high>",\n' +
            '  "bias_direction": "<left|center-left|center|center-right|right|unknown>",\n' +
            '  "bias_note": "<one sentence>",\n' +
            '  "threads": ["<confirmed-slug-or-new-slug>"],\n' +
            '  "people": [{"name": "Full Name", "role": "title", "country": "ISO2"}],\n' +
            '  "marketTags": ["<tag>"],\n' +
            '  "expandedSummary": "<120-150 word neutral journalistic briefing>"\n' +
            '}\n' +
            'For threads: confirm or correct the keyword-detected list. Only include slugs that clearly apply.\n' +
            'For people: extract up to 4 key political figures mentioned. Omit if none.\n' +
            'For marketTags: confirm or correct from keyword list. Valid values: oil-markets, defense-spending, sanctions-trade, currency-wars, commodity-prices, central-bank-policy, tech-regulation, debt-crisis.\n' +
            'expandedSummary: write a clear, neutral 120-150 word briefing that explains what happened and why it matters.',
        },
      ],
    });
    const parsed = JSON.parse(completion.choices[0].message.content.trim());

    // Validate and sanitize threads
    const aiThreads = Array.isArray(parsed.threads)
      ? parsed.threads.filter((s) => typeof s === 'string' && s.length < 60).slice(0, 8)
      : [];

    // Merge keyword threads + AI-confirmed threads (deduplicated)
    const allThreads = [...new Set([...keywordThreads, ...aiThreads])];

    // Validate marketTags
    const VALID_MARKET_TAGS = ['oil-markets', 'defense-spending', 'sanctions-trade', 'currency-wars', 'commodity-prices', 'central-bank-policy', 'tech-regulation', 'debt-crisis'];
    const aiMarketTags = Array.isArray(parsed.marketTags)
      ? parsed.marketTags.filter((t) => VALID_MARKET_TAGS.includes(t))
      : [];
    const allMarketTags = [...new Set([...keywordMarketTags, ...aiMarketTags])];

    // People
    const people = Array.isArray(parsed.people)
      ? parsed.people.slice(0, 4).map((p) => ({
          name:    String(p.name  || '').slice(0, 100),
          role:    String(p.role  || '').slice(0, 100),
          country: String(p.country || '').slice(0, 5).toUpperCase(),
        }))
      : [];

    return {
      quality:         Math.min(10, Math.max(1, Number(parsed.quality) || 5)),
      qualityNote:     String(parsed.quality_note || '').slice(0, 250),
      biasLevel:       ['low', 'medium', 'high'].includes(parsed.bias_level) ? parsed.bias_level : 'medium',
      biasDirection:   ['left', 'center-left', 'center', 'center-right', 'right', 'unknown'].includes(parsed.bias_direction)
        ? parsed.bias_direction : 'unknown',
      biasNote:        String(parsed.bias_note || '').slice(0, 350),
      threads:         allThreads,
      marketTags:      allMarketTags,
      people,
      expandedSummary: String(parsed.expandedSummary || '').slice(0, 2000),
    };
  } catch {
    return null;
  }
}

// ─── Source fetchers ─────────────────────────────────────────────────────────
async function fetchFromNewsAPI() {
  const key = process.env.NEWSAPI_KEY;
  if (!key) return [];
  // Free plan: 100 req/day  → 3 calls per cycle, 45-min guard = ~96/day max.
  if (!guardedFetch('newsapi', 45 * 60 * 1000)) return [];
  const UA = { 'User-Agent': 'PulseReader/1.0 (news aggregator)' };

  // Wire services, major political newspapers, and international outlets.
  // Include mainstream media for political/war/economic coverage — the bias
  // classifier flags partisan framing so users stay media-literate.
  const MAINSTREAM_SOURCES = [
    'reuters', 'associated-press', 'al-jazeera-english',
    'bbc-news', 'cnn', 'fox-news',
    'the-new-york-times', 'the-washington-post', 'the-guardian-uk',
    'the-economist', 'the-wall-street-journal', 'politico',
    'the-hill', 'axios', 'foreign-policy', 'the-american-conservative',
    'national-review', 'newsweek', 'time',
  ].join(',');

  // Balanced domain list: major mainstream + independent left/right outlets
  const ALL_DOMAINS = [
    // Wire / international
    'apnews.com', 'reuters.com', 'bbc.com', 'bbc.co.uk', 'aljazeera.com',
    'theguardian.com', 'ft.com', 'economist.com',
    // US mainstream (political content)
    'nytimes.com', 'washingtonpost.com', 'wsj.com', 'politico.com',
    'thehill.com', 'axios.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com',
    'usatoday.com', 'msnbc.com', 'cnn.com', 'foxnews.com',
    // Right-leaning
    'washingtonexaminer.com', 'dailycaller.com', 'thefederalist.com',
    'newsmax.com', 'nypost.com', 'nationalreview.com', 'theblaze.com',
    // Left-leaning independent
    'theintercept.com', 'motherjones.com', 'thenation.com',
    'slate.com', 'newrepublic.com',
  ].join(',');

  const q1 = encodeURIComponent('politics OR war OR election OR conflict OR military OR coup OR geopolitics');
  const q2 = encodeURIComponent('diplomacy OR sanctions OR "trade war" OR economy OR inflation OR recession');

  const results = await Promise.allSettled([
    // 1. Top headlines from major news sources (mainstream + wire + independent)
    fetchJSON(
      `https://newsapi.org/v2/top-headlines?sources=${MAINSTREAM_SOURCES}&pageSize=100&apiKey=${encodeURIComponent(key)}`,
      UA
    ),
    // 2. War/politics/conflict keyword search across broad domain list
    fetchJSON(
      `https://newsapi.org/v2/everything?q=${q1}&domains=${ALL_DOMAINS}&language=en&pageSize=100&sortBy=publishedAt&apiKey=${encodeURIComponent(key)}`,
      UA
    ),
    // 3. Economy/diplomacy keyword search for financial/sanctions/trade coverage
    fetchJSON(
      `https://newsapi.org/v2/everything?q=${q2}&domains=${ALL_DOMAINS}&language=en&pageSize=100&sortBy=publishedAt&apiKey=${encodeURIComponent(key)}`,
      UA
    ),
  ]);

  const seen = new Set();
  const articles = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.warn('[aggregator] NewsAPI sub-request error:', result.reason?.message);
      continue;
    }
    for (const a of (result.value.articles || [])) {
      if (!a.url || !a.title || a.title.includes('[Removed]') || seen.has(a.url)) continue;
      seen.add(a.url);
      articles.push({
        title:       (a.title || '').slice(0, 300),
        articleUrl:  a.url,
        source:      a.source?.name || 'NewsAPI',
        apiSource:   'newsapi',
        author:      (a.author || '').slice(0, 150),
        summary:     (a.description || '').slice(0, 1000),
        imageUrl:    a.urlToImage || '',
        publishedAt: a.publishedAt ? new Date(a.publishedAt) : new Date(),
      });
    }
  }
  return articles;
}

// ─── Webz.io News API Lite ────────────────────────────────────────────────────
async function fetchFromWebzio() {
  const token = process.env.WEBZ_KEY;
  if (!token) return [];
  // Free tier: 1,000 calls/month (~33/day). 1 call per 60-min guard = 24/day max.
  // Max 10 articles per call — use one powerful Boolean query to maximize value.
  if (!guardedFetch('webzio', 60 * 60 * 1000)) return [];

  const ts48h = Date.now() - 48 * 60 * 60 * 1000;
  // Single compound Boolean query covering all target topics
  const q = '(politics OR war OR conflict OR military OR election OR coup OR diplomacy OR sanctions OR geopolitics OR inflation OR recession OR "trade war" OR "foreign policy") AND language:english';

  const result = await fetchJSON(
    `https://api.webz.io/newsApiLite?token=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}&sort=crawled&order=desc&ts=${ts48h}&size=10`
  ).catch((err) => {
    console.warn('[aggregator] Webz.io error:', err.message);
    return null;
  });

  if (!result) return [];
  const articles = [];
  const seen = new Set();
  for (const a of (result.posts || [])) {
    const url = a.url;
    if (!url || !a.title || seen.has(url)) continue;
    seen.add(url);
    articles.push({
      title:       (a.title || '').slice(0, 300),
      articleUrl:  url,
      source:      a.thread?.site_full || a.thread?.title || 'Webz.io',
      apiSource:   'webzio',
      author:      (a.author || '').slice(0, 150),
      summary:     (a.text || a.thread?.title_full || '').slice(0, 1000),
      imageUrl:    '',
      publishedAt: a.published ? new Date(Number(a.published)) : new Date(),
    });
  }
  console.log(`[aggregator] Webz.io: fetched ${articles.length} articles`);
  return articles;
}

// ─── WorldNewsAPI.com ────────────────────────────────────────────────────────
async function fetchFromWorldNewsAPI() {
  const key = process.env.WORLDNEWS_KEY;
  if (!key) return [];
  // Guard to 45-min minimum: 3 calls per cycle × 32 cycles/day = 96 calls/day.
  if (!guardedFetch('worldnews', 45 * 60 * 1000)) return [];

  const earliest = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Use semantic search with targeted political/war/economic terms.
  // Pull from multiple source countries for global non-US-centric coverage.
  const results = await Promise.allSettled([
    fetchJSON(
      `https://api.worldnewsapi.com/search-news?api-key=${encodeURIComponent(key)}&text=${encodeURIComponent('war conflict military coup election sanctions diplomacy geopolitics')}&number=100&language=en&earliest-publish-date=${encodeURIComponent(earliest)}&sort=publish-time&sort-direction=DESC`
    ),
    fetchJSON(
      `https://api.worldnewsapi.com/search-news?api-key=${encodeURIComponent(key)}&text=${encodeURIComponent('economy inflation recession trade tariff central bank foreign policy')}&number=100&language=en&earliest-publish-date=${encodeURIComponent(earliest)}&sort=publish-time&sort-direction=DESC`
    ),
    // Third query specifically targeting active war zones for better coverage
    fetchJSON(
      `https://api.worldnewsapi.com/search-news?api-key=${encodeURIComponent(key)}&text=${encodeURIComponent('Ukraine Russia Gaza Israel Sudan Myanmar Houthi NATO airstrike ceasefire offensive')}&number=100&language=en&earliest-publish-date=${encodeURIComponent(earliest)}&sort=publish-time&sort-direction=DESC`
    ),
  ]);

  const seen = new Set();
  const articles = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.warn('[aggregator] WorldNewsAPI sub-request error:', result.reason?.message);
      continue;
    }
    for (const a of (result.value.news || [])) {
      const url = a.url;
      if (!url || !a.title || seen.has(url)) continue;
      seen.add(url);
      let hostname = 'WorldNewsAPI';
      try { hostname = new URL(url).hostname.replace('www.', ''); } catch { /* ignore */ }
      articles.push({
        title:       (a.title || '').slice(0, 300),
        articleUrl:  url,
        source:      hostname,
        apiSource:   'worldnews',
        author:      (a.author || a.authors?.[0] || '').slice(0, 150),
        summary:     (a.text || '').slice(0, 1000),
        imageUrl:    a.image || '',
        publishedAt: a.publish_date ? new Date(a.publish_date) : new Date(),
      });
    }
  }
  console.log(`[aggregator] WorldNewsAPI: fetched ${articles.length} articles`);
  return articles;
}

// ─── NewsData.io ──────────────────────────────────────────────────────────────
async function fetchFromNewsData() {
  const key = process.env.NEWSDATA_KEY;
  if (!key) return [];
  // Free tier: 200 req/day. 2 calls per 30-min cycle = 96/day.
  if (!guardedFetch('newsdata', 30 * 60 * 1000)) return [];

  // Target political/world/military categories — exclude entertainment/lifestyle.
  // NewsData.io supports excludecategory to strip noise in one call.
  // Valid NewsData.io categories: politics, world, top, crime, domestic, government, business.
  // (military/conflict/defence are NOT valid category IDs — use keyword search instead)
  const CATEGORY_SETS = [
    { category: 'politics,world,top',      q: encodeURIComponent('war conflict military election sanctions') },
    { category: 'crime,domestic,business', q: encodeURIComponent('economy tariff inflation foreign policy diplomacy') },
  ];
  const EXCLUDE = 'entertainment,sports,lifestyle,food,travel,health,science,technology';

  const results = await Promise.allSettled(
    CATEGORY_SETS.map(({ category, q }) =>
      fetchJSON(
        `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(key)}&language=en&category=${category}&q=${q}&excludecategory=${EXCLUDE}`
      )
    )
  );

  const seen = new Set();
  const articles = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.warn('[aggregator] NewsData.io sub-request error:', result.reason?.message);
      continue;
    }
    for (const a of (result.value.results || [])) {
      const url = a.link;
      if (!url || !a.title || seen.has(url)) continue;
      seen.add(url);
      articles.push({
        title:       (a.title || '').slice(0, 300),
        articleUrl:  url,
        source:      a.source_name || a.source_id || 'NewsData.io',
        apiSource:   'newsdata',
        author:      (Array.isArray(a.author) ? a.author[0] : a.author || '').slice(0, 150),
        summary:     (a.description || a.content || '').slice(0, 1000),
        imageUrl:    a.image_url || '',
        publishedAt: a.pubDate ? new Date(a.pubDate) : new Date(),
      });
    }
  }
  console.log(`[aggregator] NewsData.io: fetched ${articles.length} articles`);
  return articles;
}

// ─── TheNewsAPI.com ──────────────────────────────────────────────────────────
async function fetchFromTheNewsAPI() {
  const token = process.env.THENEWSAPI_KEY;
  if (!token) return [];
  // Free tier is heavily rate-limited — guard to 120-min minimum between calls
  // to stay well within daily quotas. Their /all endpoint is more generous.
  if (!guardedFetch('thenewsapi', 120 * 60 * 1000)) return [];

  const published_after = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // /news/all with politics+world categories and keyword search.
  // Use date-only format for published_after (ISO date YYYY-MM-DD).
  const result = await fetchJSON(
    `https://api.thenewsapi.com/v1/news/all?api_token=${encodeURIComponent(token)}&language=en&categories=politics,world,business&search=${encodeURIComponent('war conflict military election coup sanctions diplomacy economy')}&limit=100&published_after=${published_after}&sort=published_at`
  ).catch((err) => {
    console.warn('[aggregator] TheNewsAPI error:', err.message);
    return null;
  });

  if (!result) return [];
  const seen = new Set();
  const articles = [];
  for (const a of (result.data || [])) {
    const url = a.url;
    if (!url || !a.title || seen.has(url)) continue;
    seen.add(url);
    articles.push({
      title:       (a.title || '').slice(0, 300),
      articleUrl:  url,
      source:      a.source || 'TheNewsAPI',
      apiSource:   'thenewsapi',
      author:      '',
      summary:     (a.description || a.snippet || '').slice(0, 1000),
      imageUrl:    a.image_url || '',
      publishedAt: a.published_at ? new Date(a.published_at) : new Date(),
    });
  }
  console.log(`[aggregator] TheNewsAPI: fetched ${articles.length} articles`);
  return articles;
}

// ─── Secure HTTPS POST ──────────────────────────────────────────────────────────────────
// Only HTTPS, block private/loopback ranges (same constraints as fetchJSON). 12s timeout, 2MB limit.
function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error('Invalid URL')); }

    if (parsed.protocol !== 'https:') {
      return reject(new Error('Only HTTPS URLs are allowed'));
    }

    const h = parsed.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) {
      return reject(new Error('Private addresses blocked'));
    }

    const payload = JSON.stringify(body);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 12000,
    };

    const req = https.request(url, options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        responseBody += chunk;
        if (responseBody.length > 2 * 1024 * 1024) { req.destroy(); reject(new Error('Response too large')); }
      });
      res.on('end', () => {
        try { resolve(JSON.parse(responseBody)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

async function fetchFromNewsAIApi() {
  const key = process.env.NEWSAPI_AI_KEY;
  if (!key) return [];
  // newsapi.ai (Event Registry) free tier: ~200 req/day. Guard to 30 min = 144/day for 3 calls.
  if (!guardedFetch('newsapi_ai', 30 * 60 * 1000)) return [];

  // Common request base — 100 articles per request (platform maximum).
  const base = {
    action:                 'getArticles',
    articlesPage:           1,
    articlesCount:          100,
    articlesSortBy:         'date',
    articlesSortByAsc:      false,
    articlesArticleBodyLen: -1,
    resultType:             'articles',
    dataType:               ['news'],
    lang:                   'eng',
    apiKey:                 key,
    isDuplicateFilter:      'skipDuplicates',
    // Accept all source-rank tiers so international & smaller-market outlets are included.
    startSourceRankPercentile: 0,
    endSourceRankPercentile:   100,
  };

  // 2 parallel queries — array keyword + keywordOper:'OR' returns significantly more
  // results than a single OR-string and gives genuinely different coverage angles.
  const results = await Promise.allSettled([
    postJSON('https://eventregistry.org/api/v1/article/getArticles', {
      ...base,
      // Political events, armed conflict, war, elections — primary target
      keyword:     ['war', 'military offensive', 'election', 'coup', 'conflict', 'ceasefire', 'invasion', 'airstrike', 'parliament dissolved', 'government collapse', 'troops', 'frontline', 'civilian casualties'],
      keywordOper: 'OR',
      // Exclude pure entertainment content
      ignoreKeyword:     ['movie', 'celebrity', 'sports', 'nfl', 'nba', 'concert', 'fashion'],
      ignoreKeywordOper: 'OR',
    }),
    postJSON('https://eventregistry.org/api/v1/article/getArticles', {
      ...base,
      // Diplomacy, geopolitics, economic warfare, trade tensions
      keyword:     ['diplomacy', 'sanctions', 'geopolitics', 'foreign policy', 'treaty', 'tariff', 'inflation', 'recession', 'debt crisis', 'central bank', 'sovereign'],
      keywordOper: 'OR',
      ignoreKeyword:     ['movie', 'celebrity', 'sports', 'nfl', 'nba', 'concert', 'fashion'],
      ignoreKeywordOper: 'OR',
    }),
    postJSON('https://eventregistry.org/api/v1/article/getArticles', {
      ...base,
      // US-focused political news — Congress, White House, Supreme Court, elections
      keyword:     ['Trump', 'Congress', 'Senate', 'White House', 'Pentagon', 'Supreme Court', 'executive order', 'DOGE', 'tariff', 'federal budget', 'immigration policy', 'CIA', 'FBI', 'State Department'],
      keywordOper: 'OR',
      sourceLocationUri: 'http://en.wikipedia.org/wiki/United_States',
      ignoreKeyword:     ['NFL', 'NBA', 'box office', 'celebrity', 'Grammy'],
      ignoreKeywordOper: 'OR',
    }),
  ]);

  const seen = new Set();
  const articles = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.warn('[aggregator] NewsAPI.ai sub-request error:', result.reason?.message);
      continue;
    }
    for (const a of (result.value.articles?.results || [])) {
      if (!a.url || !a.title || seen.has(a.url)) continue;
      seen.add(a.url);
      articles.push({
        title:       (a.title || '').slice(0, 300),
        articleUrl:  a.url,
        source:      a.source?.title || 'NewsAPI.ai',
        apiSource:   'newsapi_ai',
        author:      (a.authors?.[0]?.name || '').slice(0, 150),
        summary:     (a.body || '').slice(0, 1000),
        imageUrl:    a.image || '',
        publishedAt: (a.date && a.time) ? new Date(a.date + 'T' + a.time + 'Z') : new Date(),
      });
    }
  }
  return articles;
}

// ─── Console progress bar ──────────────────────────────────────────────────────
function renderProgress(processed, total, newlySaved, errors, startMs) {
  const pct    = total > 0 ? processed / total : 0;
  const BAR    = 30;
  const filled = Math.round(pct * BAR);
  const bar    = '\u2588'.repeat(filled) + '\u2591'.repeat(BAR - filled);
  const elapsed = Math.round((Date.now() - startMs) / 1000);
  const eStr   = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  let etaStr   = 'calculating\u2026';
  if (processed > 0 && pct < 1) {
    const rem = Math.max(0, Math.round(elapsed / pct) - elapsed);
    etaStr = `~${Math.floor(rem / 60)}:${String(rem % 60).padStart(2, '0')}`;
  } else if (pct >= 1) {
    etaStr = 'done';
  }
  const line =
    `[aggregator] [${bar}] ${processed}/${total} (${Math.round(pct * 100)}%) ` +
    `| +${newlySaved} saved | ${errors} errors | ${eStr} elapsed | ETA ${etaStr}`;
  process.stdout.write(`\r\x1b[K${line}`);
}

// ─── Main aggregation cycle ──────────────────────────────────────────────────
async function runAggregation() {
  console.log('[aggregator] Starting cycle…');
  const openai = getOpenAI();

  const [newsapi, newsaiai, webzio, worldnews, newsdata, thenewsapi] = await Promise.all([
    fetchFromNewsAPI(),
    fetchFromNewsAIApi(),
    fetchFromWebzio(),
    fetchFromWorldNewsAPI(),
    fetchFromNewsData(),
    fetchFromTheNewsAPI(),
  ]);

  const all = [...newsapi, ...newsaiai, ...webzio, ...worldnews, ...newsdata, ...thenewsapi];
  console.log(`[aggregator] Fetched ${all.length} articles from ${[
    newsapi.length && 'NewsAPI.org', newsaiai.length && 'NewsAPI.ai',
    webzio.length && 'Webz.io', worldnews.length && 'WorldNewsAPI',
    newsdata.length && 'NewsData.io', thenewsapi.length && 'TheNewsAPI',
  ].filter(Boolean).join(', ')}`);

  // ── Batch dedup: 1 query instead of N individual findOne calls ─────────────
  const allUrls = all.map((a) => a.articleUrl).filter(Boolean);
  const existingUrls = new Set(
    (await GlobalArticle.find({ articleUrl: { $in: allUrls } }).select('articleUrl').lean())
      .map((a) => a.articleUrl)
  );

  // Pre-filter: skip already-saved and irrelevant articles before the loop.
  // Also deduplicate by URL within this batch — the same article can appear from
  // multiple API sources (e.g. Reuters linked by both NewsAPI and Guardian).
  // Keep the first occurrence; the upsert in processOne handles any race.
  const seenInBatch = new Set();
  const toProcess = all.filter((a) => {
    if (!a.articleUrl) return false;
    if (existingUrls.has(a.articleUrl)) return false;
    if (!isRelevant(a.title, a.summary)) return false;
    if (isMainstreamMedia(a.articleUrl)) return false; // strip mainstream outlets
    if (seenInBatch.has(a.articleUrl)) return false;
    seenInBatch.add(a.articleUrl);
    return true;
  });
  const alreadyKnown = existingUrls.size;
  const irrelevant   = all.length - alreadyKnown - toProcess.length;
  console.log(`[aggregator] ${toProcess.length} new to analyze — ${alreadyKnown} already in DB, ${irrelevant} irrelevant.`);

  let saved = 0, errors = 0, processed = 0;
  const total      = toProcess.length;
  const cycleStart = Date.now();
  renderProgress(0, total || 1, 0, 0, cycleStart);

  if (total > 0) {
    // ── 5 concurrent workers — parallel OpenAI calls cut wall-clock time ~5× ──
    const CONCURRENCY = 5;
    let queueIndex = 0;

    const processOne = async (article) => {
      // 1. Classifiers (sync, zero API cost)
      article.category = detectCategory(article.title, article.summary);
      const country    = detectCountry(article.title, article.summary, article.apiSource);
      const region     = countryToRegion(country);

      // 2. Keyword-based thread + market tag assignment (zero API cost)
      const keywordThreads    = assignThreadsKeyword(article.title, article.summary);
      const keywordMarketTags = detectMarketTags(article.title, article.summary);

      // 3. PHASE 1: Persist article immediately with keyword-only data so a
      //    mid-cycle server restart can never lose it.  Use upsert so we don't
      //    error if a cross-source duplicate beat us here.
      let docId;
      try {
        const result = await GlobalArticle.findOneAndUpdate(
          { articleUrl: article.articleUrl },
          {
            $setOnInsert: {
              ...article,
              country,
              region,
              threads:         keywordThreads,
              marketTags:      keywordMarketTags,
              people:          [],
              expandedSummary: '',
              qualityScore:    5,
              qualityNote:     '',
              biasLevel:       'medium',
              biasDirection:   'unknown',
              biasNote:        '',
              processedAt:     null,
              analysisModel:   'pending',
              heatScore:       calcHeatScore({ ...article, qualityScore: 5 }),
              lastHeatCalc:    new Date(),
            },
          },
          { upsert: true, new: true, fields: { _id: 1, analysisModel: 1 } }
        );
        docId = result?._id;
        // If the document already existed (another worker or prior cycle saved it),
        // skip re-analysis to avoid double OpenAI spend.
        if (result && result.analysisModel && result.analysisModel !== 'pending') {
          processed++;
          renderProgress(processed, total, saved, errors, cycleStart);
          return;
        }
      } catch (err) {
        process.stdout.write('\n');
        console.warn('[aggregator] Phase-1 save error:', err.message);
        errors++;
        processed++;
        renderProgress(processed, total, saved, errors, cycleStart);
        return;
      }

      // 4. PHASE 2: OpenAI extended analysis (bias + quality + threads + people + summary)
      const analysis = await analyzeArticle(openai, article.title, article.summary, article.source, keywordThreads, keywordMarketTags);

      // 5. PHASE 3: Update document with AI results (or mark complete without AI)
      try {
        const heatScore = calcHeatScore({ ...article, qualityScore: analysis?.quality || 5 });
        await GlobalArticle.updateOne(
          { _id: docId },
          {
            $set: {
              threads:         analysis?.threads         || keywordThreads,
              marketTags:      analysis?.marketTags      || keywordMarketTags,
              people:          analysis?.people          || [],
              expandedSummary: analysis?.expandedSummary || '',
              qualityScore:    analysis?.quality         || 5,
              qualityNote:     analysis?.qualityNote     || '',
              biasLevel:       analysis?.biasLevel       || 'medium',
              biasDirection:   analysis?.biasDirection   || 'unknown',
              biasNote:        analysis?.biasNote        || '',
              processedAt:     new Date(),
              analysisModel:   analysis ? 'gpt-4o-mini' : 'keyword-only',
              heatScore,
              lastHeatCalc:    new Date(),
            },
          }
        );

        // 6. Create ArticleContent (AI summary + optional full text)
        const expandedSummary = analysis?.expandedSummary || article.summary || '';
        const wordCount = expandedSummary.split(/\s+/).filter(Boolean).length;
        const readingTimeMinutes = Math.max(1, Math.round(wordCount / 200));
        const keyPoints = expandedSummary
          .split(/(?<=\.)\s+/)
          .filter((s) => s.length > 20)
          .slice(0, 5);
        await ArticleContent.create({
          articleId:        docId,
          articleUrl:       article.articleUrl,
          source:           article.source,
          expandedSummary,
          keyPoints,
          wordCount,
          readingTimeMinutes,
          extractionMethod: 'ai-summary',
          extractedAt:      new Date(),
        }).catch(() => {}); // silently skip if duplicate

        saved++;
      } catch (err) {
        process.stdout.write('\n');
        console.warn('[aggregator] Phase-3 update error:', err.message);
        errors++;
      }
      processed++;
      renderProgress(processed, total, saved, errors, cycleStart);
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, total) }, async () => {
      while (queueIndex < total) {
        const article = toProcess[queueIndex++];
        await processOne(article);
      }
    });
    await Promise.all(workers);
  }

  // Leave progress bar on its own line, then print summary
  process.stdout.write('\n');

  // Recalculate heat scores for all articles published in the last 48 h
  const recent = await GlobalArticle.find({
    publishedAt: { $gte: new Date(Date.now() - 48 * 3_600_000) },
  }).select('views saves shares publishedAt qualityScore').lean();

  const heatOps = recent.map((a) => ({
    updateOne: {
      filter: { _id: a._id },
      update: { $set: { heatScore: calcHeatScore(a), lastHeatCalc: new Date() } },
    },
  }));
  if (heatOps.length) await GlobalArticle.bulkWrite(heatOps);

  // Recompute thread counters + heat scores
  await updateAllThreadCounters().catch((e) => console.warn('[aggregator] thread counter update failed:', e.message));
  await updatePersonCounters().catch((e) => console.warn('[aggregator] person counter update failed:', e.message));

  // Auto-spawn new threads from emerging article patterns, then prune stale ones
  await autoSpawnThreads(openai).catch((e) => console.warn('[aggregator] autoSpawnThreads failed:', e.message));
  await pruneStaleThreads().catch((e) => console.warn('[aggregator] pruneStaleThreads failed:', e.message));

  console.log(`[aggregator] Done. Saved ${saved} | Errors ${errors} | Heat updated for ${recent.length} recent.`);
}

// ─── Auto-spawn new threads from emerging article patterns ───────────────────
// After each aggregation cycle, look for slugs that OpenAI assigned to articles
// but have no Thread document yet.  If ≥3 articles share the same slug in the
// last 24 h, ask OpenAI whether it should become an official storyline.
async function autoSpawnThreads(openai) {
  if (!openai) return;
  try {
    const ago24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [existingSlugs, newSlugAgg] = await Promise.all([
      Thread.distinct('slug'),
      GlobalArticle.aggregate([
        { $match: { publishedAt: { $gte: ago24h }, threads: { $exists: true, $ne: [] } } },
        { $unwind: '$threads' },
        { $group: { _id: '$threads', count: { $sum: 1 }, titles: { $push: '$title' } } },
        { $match: { count: { $gte: 3 } } },
        { $sort: { count: -1 } },
        { $limit: 30 },
      ]),
    ]);

    const existingSet = new Set(existingSlugs);
    const candidates = newSlugAgg.filter(
      (s) => !existingSet.has(s._id) && /^[a-z0-9-]{4,80}$/.test(s._id)
    );

    if (!candidates.length) return;
    console.log(`[aggregator] Evaluating ${candidates.length} candidate new thread(s)…`);

    const VALID_REGIONS  = ['Americas', 'Europe', 'MiddleEast', 'Asia', 'Africa', 'Global'];
    const VALID_CATS     = ['conflict', 'diplomacy', 'politics', 'economy', 'world'];

    for (const candidate of candidates.slice(0, 5)) {
      try {
        const headlines = candidate.titles.slice(0, 6).join('\n- ');
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 300,
          messages: [
            {
              role: 'system',
              content: 'You are a political news editor. Respond ONLY with valid JSON — no markdown, no extra text.',
            },
            {
              role: 'user',
              content:
                `${candidate.count} recent articles have been tagged with the storyline slug "${candidate._id}" but no thread exists for it.\n` +
                `Sample headlines:\n- ${headlines}\n\n` +
                `Should this become an official ongoing storyline?\n` +
                `If YES: {"create":true,"name":"<60 char name>","description":"<120 char description>","icon":"<one emoji>","color":"<hex e.g. #E53E3E>","region":"<Americas|Europe|MiddleEast|Asia|Africa|Global>","parentCategory":"<conflict|diplomacy|politics|economy|world>","keywords":["kw1","kw2","kw3"]}\n` +
                `If NO: {"create":false}`,
            },
          ],
        });

        const raw = completion.choices[0]?.message?.content?.trim() || '{"create":false}';
        const parsed = JSON.parse(raw);
        if (!parsed.create) continue;

        const slug = candidate._id.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80);
        await Thread.create({
          slug,
          name:           String(parsed.name        || slug).slice(0, 100),
          description:    String(parsed.description || '').slice(0, 300),
          icon:           String(parsed.icon         || '📰').slice(0, 10),
          color:          /^#[0-9a-f]{6}$/i.test(parsed.color) ? parsed.color : '#6B7280',
          region:         VALID_REGIONS.includes(parsed.region) ? parsed.region : 'Global',
          parentCategory: VALID_CATS.includes(parsed.parentCategory) ? parsed.parentCategory : 'world',
          relatedKeywords: Array.isArray(parsed.keywords)
            ? parsed.keywords.filter((k) => typeof k === 'string' && k.length < 60).slice(0, 20)
            : [],
          isActive:    true,
          autoSpawned: true,
        });
        console.log(`[aggregator] Auto-spawned thread: "${slug}" (${candidate.count} articles)`);
      } catch (err) {
        if (err.code !== 11000) {
          console.warn(`[aggregator] Failed to evaluate/spawn "${candidate._id}":`, err.message);
        }
      }
    }
  } catch (err) {
    console.warn('[aggregator] autoSpawnThreads error:', err.message);
  }
}

// ─── Prune stale auto-spawned threads ────────────────────────────────────────
// Deactivates auto-spawned threads that have had zero articles for 30 days.
// Manually-seeded (autoSpawned:false) threads are never pruned — they represent
// important ongoing watch topics even when quiet.
async function pruneStaleThreads() {
  try {
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await Thread.updateMany(
      {
        isActive:    true,
        isPinned:    false,
        autoSpawned: true,
        $or: [
          { articleCount: 0 },
          { lastActivity: { $lt: cutoff30d } },
        ],
      },
      { $set: { isActive: false } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[aggregator] Pruned ${result.modifiedCount} stale auto-spawned thread(s).`);
    }
  } catch (err) {
    console.warn('[aggregator] pruneStaleThreads error:', err.message);
  }
}

// ─── Update thread counters + heat scores ────────────────────────────────────
async function updateAllThreadCounters() {
  const now   = new Date();
  const ago24 = new Date(now - 24 * 60 * 60 * 1000);
  const ago7d = new Date(now - 7  * 24 * 60 * 60 * 1000);

  // Single aggregation replaces N×4 individual countDocuments + findOne queries
  const [threads, stats] = await Promise.all([
    Thread.find({ isActive: true }).select('slug').lean(),
    GlobalArticle.aggregate([
      { $match: { threads: { $exists: true, $ne: [] } } },
      { $unwind: '$threads' },
      { $group: {
          _id:          '$threads',
          total:        { $sum: 1 },
          count24h:     { $sum: { $cond: [{ $gte: ['$publishedAt', ago24] }, 1, 0] } },
          count7d:      { $sum: { $cond: [{ $gte: ['$publishedAt', ago7d]  }, 1, 0] } },
          lastActivity: { $max: '$publishedAt' },
      }},
    ]),
  ]);

  const statsMap = new Map(stats.map((s) => [s._id, s]));
  const ops = threads.map((t) => {
    const s = statsMap.get(t.slug) || { total: 0, count24h: 0, count7d: 0, lastActivity: null };
    const heatScore = s.count24h * 3 + s.count7d * 0.5 + s.total * 0.01;
    return {
      updateOne: {
        filter: { slug: t.slug },
        update: { $set: { articleCount: s.total, articleCount24h: s.count24h, articleCount7d: s.count7d, heatScore, lastActivity: s.lastActivity || null } },
      },
    };
  });
  if (ops.length) await Thread.bulkWrite(ops);
}

// ─── Update person counters ───────────────────────────────────────────────────
async function updatePersonCounters() {
  const ago7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const ago24 = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const agg = await GlobalArticle.aggregate([
    { $match: { 'people.0': { $exists: true } } },
    { $unwind: '$people' },
    { $group: {
        _id: '$people.name',
        role:    { $first: '$people.role' },
        country: { $first: '$people.country' },
        total:   { $sum: 1 },
        count7d: { $sum: { $cond: [{ $gte: ['$publishedAt', ago7d] }, 1, 0] } },
        count24h:{ $sum: { $cond: [{ $gte: ['$publishedAt', ago24] }, 1, 0] } },
    }},
  ]);

  const ops = agg.map((p) => {
    const slug = p._id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return {
      updateOne: {
        filter: { slug },
        update: { $set: { canonicalName: p._id, slug, role: p.role || '', country: p.country || '', articleCount: p.total, articleCount7d: p.count7d, articleCount24h: p.count24h } },
        upsert: true,
      },
    };
  });
  if (ops.length) await Person.bulkWrite(ops);
}

// ─── Re-analyze articles that were interrupted mid-cycle ─────────────────────
// Any article saved with analysisModel:'pending' was written in Phase 1 but the
// server was killed before Phase 3 (OpenAI update) completed.  Run OpenAI on
// them now so they get proper bias/quality/thread data.
async function reanalyzePending(openai) {
  if (!openai) return;
  try {
    const pending = await GlobalArticle.find({ analysisModel: 'pending' })
      .select('_id title summary source threads marketTags')
      .limit(50)
      .lean();
    if (!pending.length) return;
    console.log(`[aggregator] Re-analyzing ${pending.length} pending article(s) from interrupted cycle…`);
    for (const art of pending) {
      try {
        const analysis = await analyzeArticle(openai, art.title, art.summary, art.source, art.threads, art.marketTags);
        if (!analysis) continue;
        await GlobalArticle.updateOne(
          { _id: art._id },
          {
            $set: {
              threads:         analysis.threads,
              marketTags:      analysis.marketTags,
              people:          analysis.people,
              expandedSummary: analysis.expandedSummary,
              qualityScore:    analysis.quality,
              qualityNote:     analysis.qualityNote,
              biasLevel:       analysis.biasLevel,
              biasDirection:   analysis.biasDirection,
              biasNote:        analysis.biasNote,
              processedAt:     new Date(),
              analysisModel:   'gpt-4o-mini',
            },
          }
        );
      } catch (err) {
        console.warn(`[aggregator] Re-analyze failed for ${art._id}:`, err.message);
      }
    }
    console.log(`[aggregator] Re-analysis of pending articles complete.`);
  } catch (err) {
    console.warn('[aggregator] reanalyzePending error:', err.message);
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
// 30-minute cycle keeps total daily API calls within free-tier limits:
// NewsAPI(2×48=96), NewsData(2×48=96), WorldNews(2×48=96),
// NewsAPI.ai(2×72=144), Webz.io(1×24=24), TheNewsAPI(1×12=12)
const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function startAggregator() {
  // Initial run — slightly delayed to let MongoDB connect.
  // First, re-analyze any articles left in 'pending' from a prior interrupted cycle.
  setTimeout(async () => {
    const openai = getOpenAI();
    await reanalyzePending(openai).catch((e) => console.warn('[aggregator] reanalyzePending failed:', e.message));
    runAggregation().catch((err) => console.error('[aggregator] Error:', err.message));
  }, 5000);

  setInterval(() => {
    runAggregation().catch((err) => console.error('[aggregator] Error:', err.message));
  }, INTERVAL_MS);

  console.log('[aggregator] Scheduled — runs every 15 minutes.');
}

module.exports = { startAggregator, calcHeatScore, updateAllThreadCounters };
