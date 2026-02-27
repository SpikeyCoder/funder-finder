#!/usr/bin/env node
/**
 * scripts/clear-cache.js
 *
 * Clears all rows from the search_cache table so the next search
 * re-runs AI matching and picks up any newly enriched website URLs.
 *
 * Usage:
 *   node scripts/clear-cache.js
 */

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_SERVICE_ROLE_KEY env variable is required.');
  process.exit(1);
}

async function main() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/search_cache?mission_hash=neq.___never___`,
    {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    console.error('Failed to clear cache:', body);
    process.exit(1);
  }

  console.log('✅ Search cache cleared. Next search will fetch fresh AI matches.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
