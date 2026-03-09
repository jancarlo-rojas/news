'use strict';
const Thread = require('../models/Thread');
const { SEED_THREADS } = require('./threads/threadKeywordMap');

async function seedThreads() {
  // Baseline bootstrap only: keep existing dynamic clusters created by AI.
  let created = 0;
  for (const t of SEED_THREADS) {
    const result = await Thread.updateOne({ slug: t.slug }, { $setOnInsert: { ...t, isActive: true } }, { upsert: true });
    if (result.upsertedCount) created++;
  }
  if (created > 0) {
    console.log(`[seedThreads] Inserted ${created} new thread(s).`);
  } else {
    console.log('[seedThreads] All threads already seeded — nothing to insert.');
  }
}

module.exports = { seedThreads };
