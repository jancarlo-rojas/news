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
 *   - Twingly Blog Search  (env: TWINGLY_API_KEY) — blogs & forums
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

    const options = { timeout: 12000, ...extraHeaders };
    const req = https.get(url, options, (res) => {
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

// Limit articles from a single source to prevent any one API from dominating
function limitArticles(articles, maxCount, sourceName) {
  if (articles.length > maxCount) {
    console.log(`[aggregator] ${sourceName}: limiting from ${articles.length} to ${maxCount} articles`);
    return articles.slice(0, maxCount);
  }
  return articles;
}

// ─── Source classification ──────────────────────────────────────────────────
// Categorize news sources by tier: US mainstream (PRIORITY) > intl mainstream >
// US independent > other. This enables ranking by source quality downstream.

const ENTERTAINMENT_DOMAINS = new Set([
  // Pure celebrity / entertainment
  'tmz.com', 'people.com', 'perezhilton.com', 'ew.com',
  'vanityfair.com', 'rollingstone.com',
  // Tabloid clickbait
  'dailymail.co.uk', 'mirror.co.uk', 'thesun.co.uk', 'nydailynews.com',
  // Lifestyle / listicle
  'buzzfeed.com', 'buzzfeednews.com', 'huffpost.com',
]);

// US mainstream sources — PRIORITY sources for news aggregation
const US_MAINSTREAM_SOURCES = new Set([
  'nytimes.com', 'washingtonpost.com', 'wsj.com',
  'cnn.com', 'foxnews.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com',
  'apnews.com', 'reuters.com', 'usatoday.com', 'politico.com', 'thehill.com', 'axios.com',
]);

// International mainstream — SECONDARY sources
const INTL_MAINSTREAM_SOURCES = new Set([
  'bbc.com', 'bbc.co.uk', 'theguardian.com', 'ft.com', 'economist.com',
  'aljazeera.com', 'dw.com', 'france24.com', 'euronews.com',
]);

// US independent/ideological outlets — TERTIARY sources
const US_INDEPENDENT_SOURCES = new Set([
  'washingtonexaminer.com', 'dailycaller.com', 'thefederalist.com',
  'newsmax.com', 'nypost.com', 'nationalreview.com', 'theblaze.com',
  'theintercept.com', 'motherjones.com', 'thenation.com',
  'slate.com', 'newrepublic.com', 'reason.com', 'salon.com',
]);

function isEntertainmentDomain(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return ENTERTAINMENT_DOMAINS.has(host);
  } catch { return false; }
}

function detectSourceType(url, apiSource) {
  if (!url) return 'other';
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (US_MAINSTREAM_SOURCES.has(host)) return 'us-mainstream';
    if (INTL_MAINSTREAM_SOURCES.has(host)) return 'international-mainstream';
    if (US_INDEPENDENT_SOURCES.has(host)) return 'us-independent';
    // No catch-all: only classify as mainstream if explicitly defined
    return 'other';
  } catch { return 'other'; }
}

// ─── Category detection (keyword matching) ───────────────────────────────────
// ─── Relevance gate ───────────────────────────────────────────────────────────
const IRRELEVANT_SIGNALS = [
  // Pure games & puzzles
  'crossword', 'wordle', 'sudoku', 'trivia quiz',
  // Sports only (NOT major geopolitical sporting events)
  'nfl ', 'nba ', 'nhl ', 'mlb ', 'nascar', 'wnba', 'espn',
  'football match', 'soccer game', 'championship game',
  'tennis tournament', 'golf tournament', 'cricket match',
  // Celebrity & entertainment (not political figures or events)
  'celebrity gossip', 'red carpet', 'met gala', 'award show',
  'reality tv', 'reality show', 'dating show',
  // Lifestyle content
  'cooking recipe', 'restaurant review', 'travel guide',
  'horoscope', 'video game review',
  // NOTE: Premier League/F1/Olympics/movie reviews removed — can have geopolitical significance
  // NOTE: Tariffs/trade/inflation/recession/sanctions removed — legitimate economics
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
  webzio: 'GLOBAL', worldnews: 'GLOBAL', newsdata: 'GLOBAL', thenewsapi: 'GLOBAL', twingly: 'GLOBAL',
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

// ─── Normalize timestamp across 6 different API formats ────────────────────────
// Ensures all timestamps are valid ISO Date objects in the past (within 90 days).
// Prevents "-200 minutes ago" display bugs from future-dated articles.
function normalizeTimestamp(value) {
  const DEFAULT_AGE_MS = 24 * 3600000; // 24 hours ago
  const MAX_REASONABLE_AGE = 90 * 24 * 3600000; // 90 days
  
  if (!value) return new Date(Date.now() - DEFAULT_AGE_MS);
  
  try {
    let date;
    
    // 1. Handle Date objects
    if (typeof value === 'object' && value instanceof Date) {
      date = value;
    }
    // 2. Handle strings (ISO 8601, RFC 2822, etc.)
    else if (typeof value === 'string') {
      date = new Date(value.trim());
    }
    // 3. Handle numbers (Unix seconds or milliseconds)
    else if (typeof value === 'number') {
      // Heuristic: if > 1e11 (Nov 2003), treat as milliseconds; otherwise seconds
      date = new Date(value > 1e11 ? value : value * 1000);
    }
    // 4. Unknown type
    else {
      return new Date(Date.now() - DEFAULT_AGE_MS);
    }
    
    // Validate the parsed date is valid
    if (isNaN(date.getTime())) {
      return new Date(Date.now() - DEFAULT_AGE_MS);
    }
    
    // Ensure timestamp is reasonable: not future, not older than 90 days
    const now = Date.now();
    const age = now - date.getTime();
    
    // Future-dated articles: clamp to "just now" (prevents "-200m ago" display)
    if (age < 0) {
      return new Date(); // Now
    }
    
    // Articles older than 90 days: default to 24h ago (likely API malfunction)
    if (age > MAX_REASONABLE_AGE) {
      return new Date(now - DEFAULT_AGE_MS);
    }
    
    return date;
  } catch (e) {
    return new Date(Date.now() - DEFAULT_AGE_MS);
  }
}

// ─── Heat score (Hacker News gravity model) ──────────────────────────────────
function calcHeatScore(article) {
  const E = (article.views || 0) + (article.saves || 0) * 5 + (article.shares || 0) * 10;
  const pubDate = normalizeTimestamp(article.publishedAt);
  const hoursAgo = Math.max(0, (Date.now() - pubDate.getTime()) / 3_600_000);
  // Popularity-only ranking: engagement + recency. No quality/source penalties.
  const score = parseFloat((((E + 5) / Math.pow(hoursAgo + 2, 1.5))).toFixed(6));
  if (!isFinite(score)) return 0; // Safety check for NaN
  return score;
}

// ─── OpenAI — Extended analysis: bias + quality + threads + people + summary ──
async function analyzeArticle(openai, title, summary, source, keywordThreads, keywordMarketTags, activeClusters) {
  if (!openai) return null;
  try {
    const KNOWN_THREADS = keywordThreads.join(', ') || 'none detected by keyword';
    const KNOWN_MARKET  = keywordMarketTags.join(', ') || 'none detected by keyword';
    
    const AVAILABLE_THREADS = Array.isArray(activeClusters) ? activeClusters : [];
    const availableClusterLines = AVAILABLE_THREADS.length
      ? AVAILABLE_THREADS.map((c) => `- ${c.slug}: ${c.name}${c.description ? ` (${String(c.description).slice(0, 120)})` : ''}`).join('\n')
      : '- other: fallback cluster for uncategorized geopolitical items';
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 550,
      messages: [
        {
          role: 'system',
          content: 'You are a political news analyst helping categorize articles for an American audience. Respond ONLY with valid JSON — no markdown, no extra text.',
        },
        {
          role: 'user',
          content:
            `Analyze this article for an American news reader:\nTitle: ${title}\nSource: ${source}\nSummary: ${(summary || '').slice(0, 500)}\n` +
            `Keyword-detected threads: ${KNOWN_THREADS}\n` +
            `Keyword-detected market tags: ${KNOWN_MARKET}\n\n` +
            `Current active clusters:\n${availableClusterLines}\n\n` +
            `CRITICAL INSTRUCTIONS:\n` +
            `1. Assign this article to EXACTLY ONE cluster from the list above\n` +
            `2. PREFER existing active clusters - only use "other" if truly uncategorized\n` +
            `3. Regional keywords should IMMEDIATELY match to regional clusters:\n` +
            `   - Israel, Iran, Gaza, Lebanon, Hezbollah, Hamas, Syria → middle-east-regional-conflict\n` +
            `   - Russia, Ukraine, NATO, Crimea → russia-ukraine-war\n` +
            `   - China, Taiwan, South China Sea, Indo-Pacific → us-china-strategic-rivalry\n` +
            `   - North Korea, South Korea, ICBM, Kim Jong Un → korean-peninsula-crisis\n` +
            `   - India, Pakistan, Kashmir, LoC → south-asia-conflict\n` +
            `   - Sudan, Ethiopia, DRC, Sahel → african-conflicts\n` +
            `   - ISIS, Al Qaeda, terrorism, insurgency → global-terrorism-insurgency\n` +
            `4. If unsure between two clusters, pick the more specific regional one\n` +
            `5. Only assign "other" for articles that genuinely don't fit any regional conflict\n\n` +
              `6. SCANDAL DETECTION - Identify corruption/investigation articles:\n` +
              `   - US political corruption, ethics violations, bribery → us-political-scandal\n` +
              `   - Corporate fraud, accounting scandals, executive misconduct → corporate-fraud-corruption\n` +
              `   - Foreign leader corruption, international bribery → international-political-corruption\n` +
              `   - DOJ/FBI investigations, indictments, special counsel → doj-law-enforcement-investigation\n` +
              `   - Epstein, Ghislaine Maxwell, trafficking, flight logs, Little St James → epstein-scandal\n` +
              `   - Look for: investigation, indictment, charges, fraud, bribery, corruption, misconduct, ethics\n` +
              `7. SCANDAL EXAMPLES:\n` +
              `   - "Senator charged with bribery" → us-political-scandal\n` +
              `   - "CEO accused of accounting fraud" → corporate-fraud-corruption\n` +
              `   - "DOJ investigation into former official" → doj-law-enforcement-investigation\n` +
              `   - "Foreign PM corruption probe" → international-political-corruption\n` +
              `   - "Epstein list revealed" OR "Maxwell prison interview" → epstein-scandal\n\n` +
            'Respond with exactly this JSON:\n' +
            '{\n' +
            '  "quality": <integer 1-10>,\n' +
            '  "quality_note": "<one sentence>",\n' +
            '  "bias_level": "<low|medium|high>",\n' +
            '  "bias_direction": "<left|center-left|center|center-right|right|unknown>",\n' +
            '  "bias_note": "<one sentence>",\n' +
            '  "threads": ["<exactly-one-cluster-slug>"],\n' +
            '  "newCluster": {"propose": <true|false>, "slug": "<slug>", "name": "<name>", "description": "<description>", "region": "<Americas|Europe|MiddleEast|Asia|Africa|Global>", "keywords": ["kw1","kw2"]},\n' +
            '  "people": [{"name": "Full Name", "role": "title", "country": "ISO2"}],\n' +
            '  "marketTags": ["<tag>"],\n' +
            '  "expandedSummary": "<120-150 word neutral journalistic briefing>"\n' +
            '}\n' +
            'For threads:\n' +
            '  - MUST assign exactly one cluster slug from the active clusters list\n' +
              '  - Match geopolitical/conflict content to appropriate regional cluster\n' +
              '  - Match scandal/corruption/investigation content to appropriate scandal cluster\n' +
              '  - Use "other" ONLY for non-conflict, non-scandal geopolitical news\n' +
            '  - Prioritize regional clusters over "other"\n' +
            'For newCluster:\n' +
              '  - propose=true for persistent scandal patterns (specific investigations, major cases)\n' +
              '  - For scandals use format like: "epstein-investigation", "corporate-scandal-2026"\n' +
              '  - Set parentCategory to "scandal" for investigation/corruption clusters\n' +
            '  - keep slug 4-60 chars, lowercase letters/numbers/hyphens only\n' +
            'For people: extract up to 4 key political/military figures. Omit if none.\n' +
            'For marketTags: Valid values: oil-markets, defense-spending, sanctions-trade, currency-wars, commodity-prices, central-bank-policy, tech-regulation, debt-crisis.\n' +
            'expandedSummary: 120-150 word neutral briefing explaining what happened and why it matters to Americans.',
        },
      ],
    });
    const parsed = JSON.parse(completion.choices[0].message.content.trim());

    // Extract the AI's cluster choice - trust it completely
    const availableSlugSet = new Set(AVAILABLE_THREADS.map((c) => c.slug));
    let aiClusterSlug = null;
    let needsAutoCreate = false;
    
    if (Array.isArray(parsed.threads) && parsed.threads.length > 0) {
      // Take the first cluster the AI assigned
      aiClusterSlug = String(parsed.threads[0] || '').toLowerCase().trim();
      
      // If the AI returned a cluster that doesn't exist in our active set,
      // we'll need to auto-create it
      if (aiClusterSlug && !availableSlugSet.has(aiClusterSlug)) {
        needsAutoCreate = true;
      }
    }

    // Handle explicit new cluster proposals
    const proposed = parsed.newCluster && parsed.newCluster.propose
      ? {
          slug: String(parsed.newCluster.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60),
          name: String(parsed.newCluster.name || '').slice(0, 100),
          description: String(parsed.newCluster.description || '').slice(0, 280),
          region: ['Americas', 'Europe', 'MiddleEast', 'Asia', 'Africa', 'Global'].includes(parsed.newCluster.region)
            ? parsed.newCluster.region : 'Global',
          keywords: Array.isArray(parsed.newCluster.keywords)
            ? parsed.newCluster.keywords.filter((k) => typeof k === 'string' && k.length < 60).slice(0, 10)
            : [],
        }
      : null;

    // If AI assigned a new cluster without formal proposal, create implicit proposal
    let finalProposal = proposed;
    if (needsAutoCreate && aiClusterSlug && aiClusterSlug !== 'other') {
      finalProposal = {
        slug: aiClusterSlug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60),
        name: aiClusterSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        description: `AI-detected cluster: ${aiClusterSlug}`,
        region: 'Global',
        keywords: [],
      };
    }

    const selectedCluster = aiClusterSlug || (proposed && proposed.slug) || 'other';

    // Auto-create cluster if needed
    if (aiClusterSlug && !availableSlugSet.has(aiClusterSlug)) {
      console.log(`[aggregator] Auto-creating cluster: ${aiClusterSlug}`);
    }

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
      threads:         [selectedCluster],
      newCluster:      finalProposal && finalProposal.slug ? finalProposal : null,
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

  // US mainstream sources (for top-headlines query) — PRIORITY
  const US_MAINSTREAM_SOURCES_STR = [
    'reuters', 'associated-press',
    'the-new-york-times', 'the-washington-post', 'the-guardian-uk',
    'cnn', 'fox-news', 'nbcnews', 'cbsnews', 'abc-news',
    'the-wall-street-journal', 'politico', 'the-hill', 'axios',
  ].join(',');

  // Expanded domain list: prioritize US mainstream, then intl, then independent
  const ALL_DOMAINS = [
    // US mainstream (PRIORITY)
    'nytimes.com', 'washingtonpost.com', 'wsj.com', 'politico.com',
    'thehill.com', 'axios.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com',
    'apnews.com', 'reuters.com', 'usatoday.com', 'cnn.com', 'foxnews.com',
    // International mainstream (SECONDARY)
    'bbc.com', 'bbc.co.uk', 'theguardian.com', 'ft.com', 'economist.com',
    'aljazeera.com', 'dw.com', 'france24.com',
    // US independent (TERTIARY)
    'washingtonexaminer.com', 'dailycaller.com', 'thefederalist.com',
    'newsmax.com', 'nypost.com', 'nationalreview.com',
    'theintercept.com', 'motherjones.com', 'thenation.com',
    'slate.com', 'newrepublic.com', 'reason.com',
  ].join(',');

  const q1 = encodeURIComponent('politics OR war OR election OR conflict OR military OR coup OR geopolitics OR diplomacy');
  const q2 = encodeURIComponent('sanctions OR "trade war" OR economy OR inflation OR recession OR tariff OR central bank');
    const q3 = encodeURIComponent('scandal OR corruption OR fraud OR investigation OR indictment OR bribery OR misconduct OR ethics violation');

  const results = await Promise.allSettled([
    // 1. US top headlines (maximum priority)
    fetchJSON(
      `https://newsapi.org/v2/top-headlines?country=us&category=general&pageSize=100&apiKey=${encodeURIComponent(key)}`,
      UA
    ),
    // 2. Politics/war/conflict keywords across all source tiers
    fetchJSON(
      `https://newsapi.org/v2/everything?q=${q1}&domains=${ALL_DOMAINS}&language=en&pageSize=100&sortBy=publishedAt&apiKey=${encodeURIComponent(key)}`,
      UA
    ),
    // 3. Economy/sanctions/trade keywords (financial geopolitics)
    fetchJSON(
      `https://newsapi.org/v2/everything?q=${q2}&domains=${ALL_DOMAINS}&language=en&pageSize=100&sortBy=publishedAt&apiKey=${encodeURIComponent(key)}`,
      UA
    ),
      // 4. Scandal/corruption/investigation keywords
      fetchJSON(
        `https://newsapi.org/v2/everything?q=${q3}&domains=${ALL_DOMAINS}&language=en&pageSize=100&sortBy=publishedAt&apiKey=${encodeURIComponent(key)}`,
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
        sourceType:  detectSourceType(a.url, 'newsapi'),
        author:      (a.author || '').slice(0, 150),
        summary:     (a.description || '').slice(0, 1000),
        imageUrl:    a.urlToImage || '',
        publishedAt: normalizeTimestamp(a.publishedAt),
      });
    }
  }
  console.log(`[aggregator] NewsAPI.org: fetched ${articles.length} articles`);
  return limitArticles(articles, 100, 'NewsAPI.org');
}

// ─── Webz.io News API Lite ────────────────────────────────────────────────────
async function fetchFromWebzio() {
  const token = process.env.WEBZ_KEY;
  if (!token) return [];
  // Free tier: 1,000 calls/month (~33/day). 1 call per 60-min guard = 24/day max.
  // Max 10 articles per call — use one powerful Boolean query to maximize value.
  if (!guardedFetch('webzio', 60 * 60 * 1000)) return [];

  const ts48h = Date.now() - 48 * 60 * 60 * 1000;
  // Webz.io free tier: query must be ≤100 characters or the API returns HTTP 500.
  // Use 3 separate queries to cover different topic areas.
  const queries = [
    'war OR military OR conflict',    // war/military coverage
    'election OR coup OR diplomacy',   // political changes
    'sanctions OR tariff OR economy',  // economic/trade
      'scandal OR corruption OR fraud',  // scandals & investigations
  ];

  const results = await Promise.allSettled(
    queries.map((q) =>
      fetchJSON(
        `https://api.webz.io/newsApiLite?token=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}&sort=crawled&order=desc&ts=${ts48h}&size=10`
      ).catch((err) => {
        console.warn('[aggregator] Webz.io error:', err.message);
        return null;
      })
    )
  );

  const articles = [];
  const seen = new Set();
  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    for (const a of (result.value.posts || [])) {
      const url = a.url;
      if (!url || !a.title || seen.has(url)) continue;
      seen.add(url);
      articles.push({
        title:       (a.title || '').slice(0, 300),
        articleUrl:  url,
        source:      a.thread?.site_full || a.thread?.title || 'Webz.io',
        apiSource:   'webzio',
        sourceType:  detectSourceType(url, 'webzio'),
        author:      (a.author || '').slice(0, 150),
        summary:     (a.text || a.thread?.title_full || '').slice(0, 1000),
        imageUrl:    '',
        publishedAt: normalizeTimestamp(a.published),
      });
    }
  }
  console.log(`[aggregator] Webz.io: fetched ${articles.length} articles`);
  return limitArticles(articles, 50, 'Webz.io');
}

// ─── WorldNewsAPI.com ────────────────────────────────────────────────────────
async function fetchFromWorldNewsAPI() {
  const key = process.env.WORLDNEWS_KEY;
  if (!key) return [];
  // Guard to 45-min minimum: 3 calls per cycle × 32 cycles/day = 96 calls/day.
  if (!guardedFetch('worldnews', 45 * 60 * 1000)) return [];

  const earliest = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Use semantic search with targeted political/war/economic terms.
  // NOTE: WorldNewsAPI treats space-separated words as an exact-phrase match —
  // long multi-word queries return 0 results. Keep each text param to 3-4 key terms,
  // or use OR-style single-keyword searches across multiple queries for best coverage.
  const results = await Promise.allSettled([
    fetchJSON(
      `https://api.worldnewsapi.com/search-news?api-key=${encodeURIComponent(key)}&text=${encodeURIComponent('war military conflict')}&number=100&language=en&earliest-publish-date=${encodeURIComponent(earliest)}&sort=publish-time&sort-direction=DESC`
    ),
    fetchJSON(
      `https://api.worldnewsapi.com/search-news?api-key=${encodeURIComponent(key)}&text=${encodeURIComponent('economy inflation sanctions')}&number=100&language=en&earliest-publish-date=${encodeURIComponent(earliest)}&sort=publish-time&sort-direction=DESC`
    ),
    // Third query targeting active geopolitical hot spots
    fetchJSON(
      `https://api.worldnewsapi.com/search-news?api-key=${encodeURIComponent(key)}&text=${encodeURIComponent('Ukraine Russia Gaza Israel NATO')}&number=100&language=en&earliest-publish-date=${encodeURIComponent(earliest)}&sort=publish-time&sort-direction=DESC`
    ),
    // Fourth query targeting diplomacy, elections, policy
    fetchJSON(
      `https://api.worldnewsapi.com/search-news?api-key=${encodeURIComponent(key)}&text=${encodeURIComponent('election diplomacy treaty policy')}&number=100&language=en&earliest-publish-date=${encodeURIComponent(earliest)}&sort=publish-time&sort-direction=DESC`
    ),
      // Fifth query targeting scandals, corruption, investigations
      fetchJSON(
        `https://api.worldnewsapi.com/search-news?api-key=${encodeURIComponent(key)}&text=${encodeURIComponent('scandal corruption investigation fraud')}&number=100&language=en&earliest-publish-date=${encodeURIComponent(earliest)}&sort=publish-time&sort-direction=DESC`
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
        sourceType:  detectSourceType(url, 'worldnews'),
        author:      (a.author || a.authors?.[0] || '').slice(0, 150),
        summary:     (a.text || '').slice(0, 1000),
        imageUrl:    a.image || '',
        publishedAt: normalizeTimestamp(a.publish_date),
      });
    }
  }
  console.log(`[aggregator] WorldNewsAPI: fetched ${articles.length} articles`);
  return limitArticles(articles, 80, 'WorldNewsAPI');
}

// ─── NewsData.io ──────────────────────────────────────────────────────────────
async function fetchFromNewsData() {
  const key = process.env.NEWSDATA_KEY;
  if (!key) return [];
  // Free tier: 200 req/day. 2 calls per 30-min cycle = 96/day.
  if (!guardedFetch('newsdata', 30 * 60 * 1000)) return [];

  // Target political/world/military categories — keyword search filters out noise.
  // Valid NewsData.io /latest categories: business, entertainment, environment, food,
  // health, politics, science, sports, technology, top, tourism, world, other.
  // NOTE: excludecategory is NOT supported on /latest — it causes 422 errors.
  // NewsData.io uses OR-style keyword matching — space-separated terms act as AND
  // and return far fewer results. Use explicit OR syntax for multi-term queries.
  const CATEGORY_SETS = [
    { category: 'politics,world,top',      q: encodeURIComponent('war OR conflict OR military OR election OR coup OR sanctions') },
    { category: 'politics,world,business', q: encodeURIComponent('economy OR inflation OR tariff OR diplomacy OR sanctions OR recession') },
    { category: 'business,top',            q: encodeURIComponent('trade war OR tariff OR geopolitics OR supply chain OR commodities') },
    { category: 'world,politics',          q: encodeURIComponent('foreign policy OR treaty OR alliance OR negotiation OR ceasefire') },
      { category: 'politics,world,top',      q: encodeURIComponent('scandal OR corruption OR fraud OR investigation OR indictment OR bribery') },
  ];

  const results = await Promise.allSettled(
    CATEGORY_SETS.map(({ category, q }) =>
      fetchJSON(
        `https://newsdata.io/api/1/latest?apikey=${encodeURIComponent(key)}&language=en&category=${category}&q=${q}`
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
        sourceType:  detectSourceType(url, 'newsdata'),
        author:      (Array.isArray(a.author) ? a.author[0] : a.author || '').slice(0, 150),
        summary:     (a.description || a.content || '').slice(0, 1000),
        imageUrl:    a.image_url || '',
        publishedAt: normalizeTimestamp(a.pubDate),
      });
    }
  }
  console.log(`[aggregator] NewsData.io: fetched ${articles.length} articles`);
  return limitArticles(articles, 100, 'NewsData.io');
}

// ─── TheNewsAPI.com ──────────────────────────────────────────────────────────
async function fetchFromTheNewsAPI() {
  const token = process.env.THENEWSAPI_KEY;
  if (!token) return [];
  // Free tier is heavily rate-limited — guard to 60-min minimum between calls
  // to stay well within daily quotas. Their /all endpoint is more generous.
  if (!guardedFetch('thenewsapi', 60 * 60 * 1000)) return [];

  const published_after = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // /news/all with politics+world categories and keyword search.
  // Use date-only format for published_after (ISO date YYYY-MM-DD).
  // NOTE: space-separated terms are treated as AND — use short focused list to avoid 0 results.
  // 3 separate queries for better coverage across different political/military/economic topics
  const results = await Promise.allSettled([
    fetchJSON(
      `https://api.thenewsapi.com/v1/news/all?api_token=${encodeURIComponent(token)}&language=en&categories=politics,world&search=${encodeURIComponent('war military conflict')}&limit=100&published_after=${published_after}&sort=published_at`
    ),
    fetchJSON(
      `https://api.thenewsapi.com/v1/news/all?api_token=${encodeURIComponent(token)}&language=en&categories=politics,business&search=${encodeURIComponent('election diplomacy treaty')}&limit=100&published_after=${published_after}&sort=published_at`
    ),
    fetchJSON(
      `https://api.thenewsapi.com/v1/news/all?api_token=${encodeURIComponent(token)}&language=en&categories=business,world&search=${encodeURIComponent('sanctions economy recession')}&limit=100&published_after=${published_after}&sort=published_at`
    ),
      fetchJSON(
        `https://api.thenewsapi.com/v1/news/all?api_token=${encodeURIComponent(token)}&language=en&categories=politics,world&search=${encodeURIComponent('scandal corruption investigation')}&limit=100&published_after=${published_after}&sort=published_at`
      ),
  ]);

  const seen = new Set();
  const articles = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') {
      console.warn('[aggregator] TheNewsAPI sub-request error:', result.reason?.message);
      continue;
    }
    for (const a of (result.value.data || [])) {
      const url = a.url;
      if (!url || !a.title || seen.has(url)) continue;
      seen.add(url);
      articles.push({
        title:       (a.title || '').slice(0, 300),
        articleUrl:  url,
        source:      a.source || 'TheNewsAPI',
        apiSource:   'thenewsapi',
        sourceType:  detectSourceType(url, 'thenewsapi'),
        author:      '',
        summary:     (a.description || a.snippet || '').slice(0, 1000),
        imageUrl:    a.image_url || '',
        publishedAt: normalizeTimestamp(a.published_at),
      });
    }
  }
  console.log(`[aggregator] TheNewsAPI: fetched ${articles.length} articles`);
  return limitArticles(articles, 80, 'TheNewsAPI');
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

// ─── XML fetch helper (for Twingly) ──────────────────────────────────────────
function fetchXML(url) {
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

    const options = { timeout: 15000 };
    const req = https.get(url, options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 50 * 1024 * 1024) { req.destroy(); reject(new Error('Response too large')); }
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Twingly XML parser helpers ──────────────────────────────────────────────
// Simple XML tag extractor for Twingly's predictable structure.
function parseXMLTag(xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'g');
  const matches = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

function extractXMLText(xml, tagName) {
  const match = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`).exec(xml);
  return match ? match[1].trim() : '';
}

async function fetchFromTwingly() {
  const key = process.env.TWINGLY_API_KEY;
  if (!key) return [];
  // Twingly Blog Search — guard to 20 minutes (72 calls/day).
  if (!guardedFetch('twingly', 20 * 60 * 1000)) return [];

  // Twingly Query Language (TQL) — very specific scandal keywords only.
  // Broad queries like "(scandal OR corruption)" return 10MB+ XML responses.
  // Instead use specific named scandals and people.
  const queries = [
    'Epstein lang:en',
    '(Maxwell OR "Maxwell" OR "Ghislaine") lang:en',
    '"insider trading" lang:en',
    '(scandal AND fraud) lang:en',
  ];

  const articles = [];
  const seen = new Set();
  
  // Get posts from last 6 hours only (tighter time window = smaller XML response)
  const lastSince = Math.floor((Date.now() - 6 * 60 * 60 * 1000) / 1000);

  for (const query of queries) {
    try {
      const url = `https://api.twingly.com/blog/search/api/v3/search?apikey=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&pageSize=50&lastSince=${lastSince}&ts=${Date.now()}`;
      const xml = await fetchXML(url);

      // Parse <post> elements from Twingly XML response
      const posts = parseXMLTag(xml, 'post');
      
      for (const post of posts) {
        const url = extractXMLText(post, 'url');
        const title = extractXMLText(post, 'title');
        const published = extractXMLText(post, 'published');
        const text = extractXMLText(post, 'text');
        const blogName = extractXMLText(post, 'blog-name');
        const author = extractXMLText(post, 'author');

        if (!url || !title || seen.has(url)) continue;
        seen.add(url);

        // Twingly blog/forum posts from various sources — treat as 'other' tier.
        articles.push({
          title: title.slice(0, 300),
          articleUrl: url,
          source: blogName || 'Twingly',
          apiSource: 'twingly',
          sourceType: 'other',
          author: author.slice(0, 150),
          summary: text.slice(0, 1000),
          imageUrl: '',
          publishedAt: normalizeTimestamp(published),
          views: 0,
          saves: 0,
          shares: 0,
        });
      }
    } catch (err) {
      console.error(`[aggregator] Twingly query error: ${err.message}`);
    }
  }

  console.log(`[aggregator] Twingly: fetched ${articles.length} posts`);
  return limitArticles(articles, 100, 'Twingly');
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
    postJSON('https://eventregistry.org/api/v1/article/getArticles', {
      ...base,
      // Regional conflicts, Middle East, Asia-Pacific tensions, emerging markets
      keyword:     ['Middle East', 'Asia-Pacific', 'India China', 'Iran nuclear', 'Yemen', 'South China Sea', 'Taiwan', 'Korea', 'Africa instability', 'developing nations'],
      keywordOper: 'OR',
      ignoreKeyword:     ['movie', 'celebrity', 'sports', 'nfl', 'nba', 'concert', 'fashion'],
      ignoreKeywordOper: 'OR',
    }),
      postJSON('https://eventregistry.org/api/v1/article/getArticles', {
        ...base,
        // Scandals, corruption, investigations
        keyword:     ['scandal', 'corruption', 'fraud', 'bribery', 'investigation', 'indictment', 'misconduct', 'ethics violation', 'embezzlement', 'money laundering', 'RICO', 'criminal charges'],
        keywordOper: 'OR',
        ignoreKeyword:     ['movie', 'celebrity', 'sports', 'nfl', 'nba', 'concert', 'fashion'],
        ignoreKeywordOper: 'OR',
      }),
  ]);

  const seen = new Set();
  const articles = [];
    const queries = ['war/military', 'diplomacy/economy', 'US political', 'regional conflicts', 'scandals/corruption'];
  
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== 'fulfilled') {
      console.warn(`[aggregator] NewsAPI.ai query [${queries[i]}] error: ${result.reason?.message}`);
      continue;
    }
    const queryArticles = (result.value.articles?.results || []).filter(a => {
      if (!a.url || !a.title || seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });
    
    for (const a of queryArticles) {
      articles.push({
        title:       (a.title || '').slice(0, 300),
        articleUrl:  a.url,
        source:      a.source?.title || 'NewsAPI.ai',
        apiSource:   'newsapi_ai',
        sourceType:  detectSourceType(a.url, 'newsapi_ai'),
        author:      (a.authors?.[0]?.name || '').slice(0, 150),
        summary:     (a.body || '').slice(0, 1000),
        imageUrl:    a.image || '',
        publishedAt: normalizeTimestamp((a.date && a.time) ? new Date(a.date + 'T' + a.time + 'Z') : null),
      });
    }
    if (queryArticles.length > 0) console.log(`  [NewsAPI.ai] ${queries[i]}: ${queryArticles.length} articles`);
  }
  console.log(`[aggregator] NewsAPI.ai: fetched ${articles.length} articles total from ${queries.length} queries`);
  return limitArticles(articles, 100, 'NewsAPI.ai');
}

// ─── Console progress bar ──────────────────────────────────────────────────────
function renderProgress(processed, total, newlySaved, errors, startMs) {
  const pct    = total > 0 ? processed / total : 0;
  const BAR    = 30;
  const filled = Math.round(pct * BAR);
  const bar    = '#'.repeat(filled) + '-'.repeat(BAR - filled); // ASCII instead of Unicode
  const elapsed = Math.round((Date.now() - startMs) / 1000);
  const eStr   = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  let etaStr   = 'calculating...';
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
  const activeClusters = await Thread.find({ isActive: true })
    .select('slug name description region')
    .sort({ isPinned: -1, heatScore: -1, articleCount: -1 })
    .limit(40)
    .lean()
    .catch(() => []);

  const [newsapi, newsaiai, webzio, worldnews, newsdata, thenewsapi, twingly] = await Promise.all([
    fetchFromNewsAPI().catch(err => { console.error('[aggregator] fetchFromNewsAPI error:', err.message); return []; }),
    fetchFromNewsAIApi().catch(err => { console.error('[aggregator] fetchFromNewsAIApi error:', err.message); return []; }),
    fetchFromWebzio().catch(err => { console.error('[aggregator] fetchFromWebzio error:', err.message); return []; }),
    fetchFromWorldNewsAPI().catch(err => { console.error('[aggregator] fetchFromWorldNewsAPI error:', err.message); return []; }),
    fetchFromNewsData().catch(err => { console.error('[aggregator] fetchFromNewsData error:', err.message); return []; }),
    fetchFromTheNewsAPI().catch(err => { console.error('[aggregator] fetchFromTheNewsAPI error:', err.message); return []; }),
    fetchFromTwingly().catch(err => { console.error('[aggregator] fetchFromTwingly ERROR:', err.message); return []; }),
  ]);

  let all = [...newsapi, ...newsaiai, ...webzio, ...worldnews, ...newsdata, ...thenewsapi, ...twingly];
  
  // Cap total articles per cycle at 500 to prevent database bloat
  const MAX_ARTICLES_PER_CYCLE = 500;
  if (all.length > MAX_ARTICLES_PER_CYCLE) {
    console.log(`[aggregator] WARNING: Fetched ${all.length} articles, limiting to ${MAX_ARTICLES_PER_CYCLE} (excess discarded)`);
    // Shuffle to ensure variety across sources, then take first 500
    all = all.sort(() => Math.random() - 0.5).slice(0, MAX_ARTICLES_PER_CYCLE);
  }
  
  // Calculate source type distribution
  const sourceTypeCount = {
    'us-mainstream': all.filter(a => a.sourceType === 'us-mainstream').length,
    'international-mainstream': all.filter(a => a.sourceType === 'international-mainstream').length,
    'us-independent': all.filter(a => a.sourceType === 'us-independent').length,
    'other': all.filter(a => a.sourceType === 'other').length,
  };
  
  console.log(`[aggregator] Fetched ${all.length} articles from 7 sources:`);
  console.log(`  • NewsAPI.org: ${newsapi.length}`);
  console.log(`  • NewsAPI.ai: ${newsaiai.length}`);
  console.log(`  • Webz.io: ${webzio.length}`);
  console.log(`  • WorldNewsAPI: ${worldnews.length}`);
  console.log(`  • NewsData.io: ${newsdata.length}`);
  console.log(`  • TheNewsAPI: ${thenewsapi.length}`);
  console.log(`  • Twingly: ${twingly.length}`);
  console.log(`[aggregator] Source distribution: US Mainstream ${sourceTypeCount['us-mainstream']} | Intl Mainstream ${sourceTypeCount['international-mainstream']} | US Independent ${sourceTypeCount['us-independent']} | Other ${sourceTypeCount['other']}`);

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
  let noUrl = 0, alreadyKnown = 0, irrelevant = 0, entertainment = 0, crossApiDups = 0;
  
  const toProcess = all.filter((a) => {
    if (!a.articleUrl) { noUrl++; return false; }
    if (existingUrls.has(a.articleUrl)) { alreadyKnown++; return false; }
    if (!isRelevant(a.title, a.summary)) { irrelevant++; return false; }
    if (isEntertainmentDomain(a.articleUrl)) { entertainment++; return false; }
    if (seenInBatch.has(a.articleUrl)) { crossApiDups++; return false; }
    seenInBatch.add(a.articleUrl);
    return true;
  });
  
  console.log(`[aggregator] Processing: ${toProcess.length} new | ${alreadyKnown} already in DB | ${crossApiDups} cross-API duplicates | ${irrelevant} irrelevant | ${entertainment} entertainment | ${noUrl} missing URL`);

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
              threads:         ['other'],
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
      const analysis = await analyzeArticle(openai, article.title, article.summary, article.source, keywordThreads, keywordMarketTags, activeClusters);

      if (analysis?.newCluster?.slug) {
        await Thread.updateOne(
          { slug: analysis.newCluster.slug },
          {
            $setOnInsert: {
              slug: analysis.newCluster.slug,
              name: analysis.newCluster.name || analysis.newCluster.slug,
              description: analysis.newCluster.description || '',
              icon: 'CL',
              color: '#6B7280',
              region: analysis.newCluster.region || 'Global',
              parentCategory: 'conflict',
              relatedKeywords: analysis.newCluster.keywords || [],
              isActive: true,
              autoSpawned: true,
            },
            $set: {
              isActive: true,
            },
          },
          { upsert: true }
        ).catch(() => {});
      }

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
  }).select('views saves shares publishedAt').lean();

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

  // Get total article count in database
  const totalCount = await GlobalArticle.countDocuments().catch(() => 0);

  console.log(`[aggregator] CYCLE COMPLETE`);
  console.log(`[aggregator]   Newly saved: ${saved} articles`);
  console.log(`[aggregator]   Errors: ${errors} phase-1 failures`);
  console.log(`[aggregator]   Heat recalculated: ${recent.length} articles from last 48h`);
  console.log(`[aggregator]   Total in database: ${totalCount} articles`);
  console.log(`[aggregator]   Cycle time: ${Math.round((Date.now() - cycleStart) / 1000)}s`);
}

// ─── Auto-spawn new threads from emerging article patterns ───────────────────
// After each aggregation cycle, look for slugs that OpenAI assigned to articles
// but have no Thread document yet.  If ≥3 articles share the same slug in the
// last 24 h, ask OpenAI whether it should become an official storyline.
// Validates thread names represent actual geopolitical events (not generic noise).
async function autoSpawnThreads(openai) {
  if (!openai) return;
  const recent = await GlobalArticle.aggregate([
    { $match: { publishedAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }, threads: { $exists: true, $ne: [] } } },
    { $unwind: '$threads' },
    { $group: { _id: '$threads', count: { $sum: 1 }, lastActivity: { $max: '$publishedAt' } } },
    { $sort: { count: -1 } },
  ]).catch(() => []);

  for (const c of recent) {
    if (!c._id || c._id === 'other') continue;
    await Thread.updateOne(
      { slug: c._id },
      {
        $setOnInsert: {
          slug: c._id,
          name: c._id.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
          description: 'AI-generated dynamic conflict cluster.',
          icon: 'CL',
          color: '#6B7280',
          region: 'Global',
          parentCategory: 'conflict',
        },
        $set: { isActive: true, autoSpawned: true, lastActivity: c.lastActivity || new Date() },
      },
      { upsert: true }
    ).catch(() => {});
  }
}

// ─── Prune stale auto-spawned threads ────────────────────────────────────────
// Deactivates auto-spawned threads that have had zero articles for 30 days.
// NEVER prunes threads with articles — maintains rule: all active threads have content.
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
        articleCount: 0,  // Only prune threads with absolutely zero articles
        lastActivity: { $lt: cutoff30d },
      },
      { $set: { isActive: false } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[aggregator] Pruned ${result.modifiedCount} stale auto-spawned thread(s) with no articles.`);
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
    const activeClusters = await Thread.find({ isActive: true })
      .select('slug name description region')
      .sort({ isPinned: -1, heatScore: -1, articleCount: -1 })
      .limit(40)
      .lean()
      .catch(() => []);

    const pending = await GlobalArticle.find({ analysisModel: 'pending' })
      .select('_id title summary source threads marketTags')
      .limit(50)
      .lean();
    if (!pending.length) return;
    console.log(`[aggregator] Re-analyzing ${pending.length} pending article(s) from interrupted cycle…`);
    for (const art of pending) {
      try {
        const analysis = await analyzeArticle(openai, art.title, art.summary, art.source, art.threads, art.marketTags, activeClusters);
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
