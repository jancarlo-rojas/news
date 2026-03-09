'use strict';

// ─── Thread keyword map ────────────────────────────────────────────────────────
// Each entry: { slug, keywords[], exclude[] }
// assignThreadsKeyword() matches against title+summary (case-insensitive)
// ──────────────────────────────────────────────────────────────────────────────

const THREAD_KEYWORD_MAP = [
  {
    slug: 'russia-ukraine-war',
    keywords: ['ukraine', 'ukrainian', 'zelensky', 'zelenskyy', 'russia', 'russian', 'putin', 'kremlin', 'donbas', 'kharkiv', 'kyiv', 'kiev', 'mariupol', 'bakhmut', 'zaporizhzhia', 'nato ukraine', 'war in ukraine', 'russia war', 'russian invasion', 'russian army'],
    exclude: [],
  },
  {
    slug: 'gaza-conflict',
    keywords: ['gaza', 'hamas', 'west bank', 'rafah', 'idf', 'israel strike', 'israel bombs', 'israel military', 'gaza ceasefire', 'palestinians killed', 'netanyahu', 'hezbollah', 'israeli offensive', 'humanitarian corridor', 'un relief', 'unrwa'],
    exclude: [],
  },
  {
    slug: 'trump-administration',
    keywords: ['trump', 'maga', 'white house policy', 'executive order', 'doge', 'elon musk government', 'jd vance', 'marco rubio', 'pete hegseth', 'oval office', 'republican senate', 'republican congress'],
    exclude: ['trump casino', 'trump tower sale'],
  },
  {
    slug: 'us-china-trade-war',
    keywords: ['china tariff', 'us tariff china', 'trade war', 'us china trade', 'decoupling', 'chip ban china', 'semiconductor china', 'china export control', 'fentanyl tariff', 'chinese goods', 'reciprocal tariff'],
    exclude: [],
  },
  {
    slug: 'iran-nuclear',
    keywords: ['iran nuclear', 'iran enrichment', 'uranium enrichment', 'iaea iran', 'iran deal', 'jcpoa', 'iran sanction', 'iran missile', 'iran threat'],
    exclude: [],
  },
  {
    slug: 'taiwan-strait',
    keywords: ['taiwan', 'taipei', 'china taiwan', 'pla taiwan', 'taiwan strait', 'taiwan invasion', 'taiwan independence', 'tsai', 'lai ching-te', 'cross-strait'],
    exclude: [],
  },
  {
    slug: 'sudan-civil-war',
    keywords: ['sudan', 'sudanese', 'rsf', 'rapid support forces', 'khartoum', 'darfur', 'sudan war', 'sudan conflict', 'sudan humanitarian'],
    exclude: [],
  },
  {
    slug: 'drc-m23-conflict',
    keywords: ['drc', 'congo', 'democratic republic of congo', 'm23', 'goma', 'kivu', 'congo conflict', 'congo war', 'rwanda congo'],
    exclude: [],
  },
  {
    slug: 'north-korea-nuclear',
    keywords: ['north korea', 'kim jong un', 'dprk', 'pyongyang', 'north korean missile', 'north korean nuclear', 'icbm korea', 'korea nuclear'],
    exclude: [],
  },
  {
    slug: 'oil-opec',
    keywords: ['opec', 'oil production', 'oil price', 'crude oil', 'opec+', 'saudi aramco', 'petrodollar', 'brent crude', 'wti crude', 'oil cut', 'oil supply'],
    exclude: [],
  },
  {
    slug: 'nato-expansion',
    keywords: ['nato', 'nato expansion', 'nato member', 'article 5', 'nato summit', 'alliance', 'finland nato', 'sweden nato', 'nato ukraine', 'nato budget', 'defense spending'],
    exclude: [],
  },
  {
    slug: 'us-immigration-crisis',
    keywords: ['immigration', 'migrant', 'border crisis', 'southern border', 'asylum seeker', 'deportation', 'ice raid', 'illegal immigrant', 'undocumented', 'border patrol', 'title 42', 'remain in mexico'],
    exclude: [],
  },
  {
    slug: 'eu-far-right',
    keywords: ['far right europe', 'european far right', 'afd', 'rassemblement national', 'marine le pen', 'giorgia meloni', 'orban', 'viktor orban', 'populist europe', 'eu election', 'european election', 'right wing party europe'],
    exclude: [],
  },
  {
    slug: 'india-pakistan-tensions',
    keywords: ['india pakistan', 'kashmir', 'line of control', 'india pakistan border', 'india military', 'pakistan military', 'modi pakistan', 'india strike pakistan'],
    exclude: [],
  },
  {
    slug: 'myanmar-civil-war',
    keywords: ['myanmar', 'burma', 'burmese', 'tatmadaw', 'junta myanmar', 'aung san suu kyi', 'national unity government', 'myanmar military', 'myanmar war', 'rakhine'],
    exclude: [],
  },
  {
    slug: 'venezuela-crisis',
    keywords: ['venezuela', 'maduro', 'venezuelan', 'caracas', 'venezuela election', 'venezuela opposition', 'edmundo gonzalez', 'venezuela sanction'],
    exclude: [],
  },
  {
    slug: 'sahel-instability',
    keywords: ['sahel', 'mali', 'burkina faso', 'niger coup', 'wagner africa', 'russia africa', 'france sahel', 'jihadist africa', 'g5 sahel', 'al-qaeda africa'],
    exclude: [],
  },
  {
    slug: 'hezbollah-israel',
    keywords: ['hezbollah', 'southern lebanon', 'nasrallah', 'israel lebanon', 'lebanon strike', 'israel hezbollah', 'idf lebanon', 'beirut strike'],
    exclude: [],
  },
  {
    slug: 'global-debt-crisis',
    keywords: ['sovereign debt', 'debt crisis', 'imf bailout', 'world bank loan', 'debt restructuring', 'default risk', 'credit rating downgrade', 'fiscal deficit', 'debt ceiling'],
    exclude: [],
  },
  {
    slug: 'us-election-2026',
    keywords: ['midterm', 'midterm election', 'senate race', 'house race', 'democrat 2026', 'republican 2026', 'us election 2026', 'senate 2026', 'house 2026', 'congressional election'],
    exclude: [],
  },
];

// ─── Market tag keyword map ────────────────────────────────────────────────────
const MARKET_KEYWORD_MAP = {
  'oil-markets':        ['oil price', 'crude oil', 'brent', 'wti', 'opec', 'petrol price', 'gasoline price', 'energy market'],
  'defense-spending':   ['defense budget', 'military spending', 'defense contract', 'lockheed', 'raytheon', 'northrop', 'arms deal', 'weapons contract'],
  'sanctions-trade':    ['sanction', 'trade restriction', 'export ban', 'import ban', 'embargo', 'blacklist', 'entity list'],
  'currency-wars':      ['currency devaluation', 'exchange rate', 'dollar drop', 'yuan rate', 'ruble', 'currency war', 'forex', 'dollar index'],
  'commodity-prices':   ['wheat price', 'grain market', 'food price', 'commodity price', 'supply chain', 'corn price', 'fertilizer price'],
  'central-bank-policy':['federal reserve', 'fed rate', 'interest rate', 'ecb', 'bank of england', 'monetary policy', 'inflation rate', 'rate hike', 'rate cut'],
  'tech-regulation':    ['tech regulation', 'antitrust tech', 'ai regulation', 'data privacy', 'digital tax', 'big tech', 'chip regulation'],
  'debt-crisis':        ['debt crisis', 'sovereign debt', 'imf', 'world bank', 'debt default', 'credit rating', 'bond yield', 'fiscal crisis'],
};

// ─── Classifier functions ──────────────────────────────────────────────────────

/**
 * Returns array of thread slugs matched by keywords in title+summary.
 */
function assignThreadsKeyword(title, summary) {
  const text = ((title || '') + ' ' + (summary || '')).toLowerCase();
  const matched = [];
  for (const t of THREAD_KEYWORD_MAP) {
    const hasExclude = t.exclude.some((kw) => text.includes(kw.toLowerCase()));
    if (hasExclude) continue;
    const hasMatch = t.keywords.some((kw) => text.includes(kw.toLowerCase()));
    if (hasMatch) matched.push(t.slug);
  }
  return matched;
}

/**
 * Returns array of market tag keys matched by keywords in title+summary.
 */
function detectMarketTags(title, summary) {
  const text = ((title || '') + ' ' + (summary || '')).toLowerCase();
  const matched = [];
  for (const [tag, keywords] of Object.entries(MARKET_KEYWORD_MAP)) {
    if (keywords.some((kw) => text.includes(kw.toLowerCase()))) {
      matched.push(tag);
    }
  }
  return matched;
}

// ─── Seed data for Thread collection ──────────────────────────────────────────
const SEED_THREADS = [
  { name: 'Russia–Ukraine War',       slug: 'russia-ukraine-war',     icon: '🇺🇦', color: '#1D4ED8', parentCategory: 'conflict',  region: 'Europe',     description: 'The ongoing war between Russia and Ukraine including frontline updates, diplomacy, and sanctions.' },
  { name: 'Gaza Conflict',            slug: 'gaza-conflict',           icon: '🕊️', color: '#DC2626', parentCategory: 'conflict',  region: 'MiddleEast', description: 'Israeli military operations in Gaza, ceasefire negotiations, and the humanitarian crisis.' },
  { name: 'Trump Administration',     slug: 'trump-administration',    icon: '🏛️', color: '#7C3AED', parentCategory: 'politics',  region: 'Americas',   description: 'Policies, executive actions, and political developments from the Trump White House.' },
  { name: 'US–China Trade War',       slug: 'us-china-trade-war',      icon: '⚖️', color: '#D97706', parentCategory: 'economy',   region: 'Global',     description: 'Tariffs, export controls, and economic tensions between the United States and China.' },
  { name: 'Iran Nuclear Crisis',      slug: 'iran-nuclear',            icon: '☢️', color: '#059669', parentCategory: 'diplomacy', region: 'MiddleEast', description: 'Iran nuclear program, IAEA inspections, and international sanctions.' },
  { name: 'Taiwan Strait Tensions',   slug: 'taiwan-strait',           icon: '🌊', color: '#0891B2', parentCategory: 'conflict',  region: 'Asia',       description: 'Cross-strait tensions, PLA military activity, and Taiwan sovereignty.' },
  { name: 'Sudan Civil War',          slug: 'sudan-civil-war',         icon: '🔴', color: '#B91C1C', parentCategory: 'conflict',  region: 'Africa',     description: 'The civil war between Sudan\'s armed forces and the Rapid Support Forces.' },
  { name: 'DRC / M23 Conflict',       slug: 'drc-m23-conflict',        icon: '🌍', color: '#065F46', parentCategory: 'conflict',  region: 'Africa',     description: 'Armed conflict in eastern DRC involving M23 rebels and regional actors.' },
  { name: 'North Korea Nuclear',      slug: 'north-korea-nuclear',     icon: '💣', color: '#374151', parentCategory: 'conflict',  region: 'Asia',       description: 'DPRK missile tests, nuclear developments, and US–Korea policy.' },
  { name: 'Oil & OPEC',               slug: 'oil-opec',                icon: '🛢️', color: '#92400E', parentCategory: 'economy',   region: 'Global',     description: 'OPEC+ production decisions, oil price movements, and energy geopolitics.' },
  { name: 'NATO Expansion',           slug: 'nato-expansion',          icon: '🛡️', color: '#1E40AF', parentCategory: 'diplomacy', region: 'Europe',     description: 'NATO enlargement, defense spending commitments, and alliance policy.' },
  { name: 'US Immigration Crisis',    slug: 'us-immigration-crisis',   icon: '🌎', color: '#6D28D9', parentCategory: 'politics',  region: 'Americas',   description: 'Migration at the US southern border, asylum policy, and ICE enforcement.' },
  { name: 'EU Far-Right Wave',        slug: 'eu-far-right',            icon: '🗳️', color: '#9F1239', parentCategory: 'politics',  region: 'Europe',     description: 'Rise of far-right parties across Europe and their impact on EU policy.' },
  { name: 'India–Pakistan Tensions',  slug: 'india-pakistan-tensions', icon: '🏔️', color: '#047857', parentCategory: 'conflict',  region: 'Asia',       description: 'Military tensions and diplomatic standoffs between India and Pakistan over Kashmir.' },
  { name: 'Myanmar Civil War',        slug: 'myanmar-civil-war',       icon: '🔺', color: '#B45309', parentCategory: 'conflict',  region: 'Asia',       description: 'Ongoing civil war between Myanmar\'s military junta and resistance forces.' },
  { name: 'Venezuela Crisis',         slug: 'venezuela-crisis',        icon: '🇻🇪', color: '#0F766E', parentCategory: 'politics',  region: 'Americas',   description: 'Venezuela\'s political and economic crisis, election disputes, and sanctions.' },
  { name: 'Sahel Instability',        slug: 'sahel-instability',       icon: '🌵', color: '#78350F', parentCategory: 'conflict',  region: 'Africa',     description: 'Jihadist insurgency, coups, and Russian Wagner presence across the Sahel.' },
  { name: 'Hezbollah vs Israel',      slug: 'hezbollah-israel',        icon: '🚀', color: '#991B1B', parentCategory: 'conflict',  region: 'MiddleEast', description: 'Cross-border strikes between Israel and Hezbollah in Lebanon.' },
  { name: 'Global Debt Crisis',       slug: 'global-debt-crisis',      icon: '📉', color: '#1D4ED8', parentCategory: 'economy',   region: 'Global',     description: 'Sovereign debt defaults, IMF bailouts, and fiscal crises around the world.' },
  { name: 'US Midterms 2026',         slug: 'us-election-2026',        icon: '🗳️', color: '#6D28D9', parentCategory: 'politics',  region: 'Americas',   description: 'The 2026 US midterm elections — Senate and House races, party dynamics.' },
];

module.exports = { THREAD_KEYWORD_MAP, MARKET_KEYWORD_MAP, assignThreadsKeyword, detectMarketTags, SEED_THREADS };
