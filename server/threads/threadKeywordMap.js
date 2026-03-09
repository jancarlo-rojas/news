'use strict';

// Baseline cluster seeds used as an initial starting point only.
// The live cluster taxonomy is dynamic and evolves via OpenAI + DB updates.
const BASELINE_CLUSTER_SEEDS = [
  { name: 'Russia-Ukraine War', slug: 'russia-ukraine-war', icon: 'UKR', color: '#1D4ED8', parentCategory: 'conflict', region: 'Europe', description: 'The ongoing interstate war between Russia and Ukraine, including frontline combat and allied military support.' },
  { name: 'Middle East Regional Conflict', slug: 'middle-east-regional-conflict', icon: 'ME', color: '#B91C1C', parentCategory: 'conflict', region: 'MiddleEast', description: 'A connected regional conflict system covering Gaza, Israel-Iran escalation, Hezbollah-Israel clashes, US-Iran tensions, and related nuclear risk.' },
  { name: 'US-China Strategic Rivalry', slug: 'us-china-strategic-rivalry', icon: 'USCN', color: '#0F766E', parentCategory: 'conflict', region: 'Asia', description: 'Strategic competition between the United States and China, centered on Taiwan and Indo-Pacific military pressure.' },
  { name: 'Korean Peninsula Crisis', slug: 'korean-peninsula-crisis', icon: 'KOR', color: '#374151', parentCategory: 'conflict', region: 'Asia', description: 'Escalation risk from North Korean missile and nuclear threats affecting regional and US security posture.' },
  { name: 'South Asia Conflict (India-Pakistan)', slug: 'south-asia-conflict', icon: 'SA', color: '#166534', parentCategory: 'conflict', region: 'Asia', description: 'Recurring India-Pakistan military and terrorism tensions with a core focus on Kashmir flashpoints.' },
  { name: 'African Conflicts', slug: 'african-conflicts', icon: 'AF', color: '#7C2D12', parentCategory: 'conflict', region: 'Africa', description: 'Major armed conflicts across Africa, including Sudan, Sahel insurgencies, and eastern DRC violence.' },
  { name: 'Global Terrorism / Insurgency', slug: 'global-terrorism-insurgency', icon: 'GT', color: '#6B7280', parentCategory: 'conflict', region: 'Global', description: 'Cross-regional militant and insurgent violence that does not fit a single state-on-state war cluster.' },
  
    // ═══ SCANDAL & CORRUPTION CLUSTERS ═══
    { name: 'US Political Scandals', slug: 'us-political-scandal', icon: 'USS', color: '#DC2626', parentCategory: 'scandal', region: 'Americas', description: 'Corruption investigations, political ethics violations, and misconduct involving US elected officials, appointees, and government employees.' },
    { name: 'Corporate Fraud & Corruption', slug: 'corporate-fraud-corruption', icon: 'CFC', color: '#EA580C', parentCategory: 'scandal', region: 'Global', description: 'Major corporate scandals including financial fraud, accounting irregularities, executive corruption, and regulatory violations affecting public companies.' },
    { name: 'International Political Corruption', slug: 'international-political-corruption', icon: 'IPC', color: '#D97706', parentCategory: 'scandal', region: 'Global', description: 'Political scandals and corruption cases involving foreign leaders, international organizations, and cross-border misconduct.' },
    { name: 'DOJ & Law Enforcement Investigations', slug: 'doj-law-enforcement-investigation', icon: 'DOJ', color: '#B91C1C', parentCategory: 'scandal', region: 'Americas', description: 'Active Department of Justice investigations, FBI probes, special counsel inquiries, and major criminal cases involving public figures.' },
    { name: 'Epstein Scandal & Associates', slug: 'epstein-scandal', icon: 'EPS', color: '#991B1B', parentCategory: 'scandal', region: 'Global', description: 'Jeffrey Epstein trafficking scandal, Ghislaine Maxwell case, flight logs, associate investigations, and related revelations involving high-profile figures.' },
  
  { name: 'Other', slug: 'other', icon: 'OTH', color: '#4B5563', parentCategory: 'world', region: 'Global', description: 'Relevant geopolitical and security news not strongly attributable to a primary conflict cluster.' },
];

// ─── Market tag keyword map ───────────────────────────────────────────────────
const MARKET_KEYWORD_MAP = {
  'oil-markets': ['oil price', 'crude oil', 'brent', 'wti', 'opec', 'petrol price', 'gasoline price', 'energy market'],
  'defense-spending': ['defense budget', 'military spending', 'defense contract', 'lockheed', 'raytheon', 'northrop', 'arms deal', 'weapons contract'],
  'sanctions-trade': ['sanction', 'trade restriction', 'export ban', 'import ban', 'embargo', 'blacklist', 'entity list'],
  'currency-wars': ['currency devaluation', 'exchange rate', 'dollar drop', 'yuan rate', 'ruble', 'currency war', 'forex', 'dollar index'],
  'commodity-prices': ['wheat price', 'grain market', 'food price', 'commodity price', 'supply chain', 'corn price', 'fertilizer price'],
  'central-bank-policy': ['federal reserve', 'fed rate', 'interest rate', 'ecb', 'bank of england', 'monetary policy', 'inflation rate', 'rate hike', 'rate cut'],
  'tech-regulation': ['tech regulation', 'antitrust tech', 'ai regulation', 'data privacy', 'digital tax', 'big tech', 'chip regulation'],
  'debt-crisis': ['debt crisis', 'sovereign debt', 'imf', 'world bank', 'debt default', 'credit rating', 'bond yield', 'fiscal crisis'],
};

function assignThreadsKeyword(title, summary) {
  // Thread/cluster categorization is handled by OpenAI only.
  return [];
}

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

const SEED_THREADS = BASELINE_CLUSTER_SEEDS;

module.exports = {
  BASELINE_CLUSTER_SEEDS,
  MARKET_KEYWORD_MAP,
  assignThreadsKeyword,
  detectMarketTags,
  SEED_THREADS,
};
