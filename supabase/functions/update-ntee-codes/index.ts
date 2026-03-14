/**
 * update-ntee-codes — Supabase Edge Function
 *
 * Batch-populates ntee_code on recipient_organizations by fetching from
 * the ProPublica Nonprofit Explorer API.  Designed to be called repeatedly
 * in shards until all viable recipients are populated.
 *
 * POST { batch_size?: number }   (default 200)
 *
 * Each invocation:
 *  1. Selects up to `batch_size` recipients WHERE ntee_code IS NULL
 *     AND funder_count >= 3, ordered by funder_count DESC (most active first)
 *  2. Fetches NTEE codes from ProPublica (10 concurrent requests)
 *  3. Updates recipient_organizations.ntee_code for each
 *  4. Returns { processed, updated, remaining, errors }
 */

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'https://spikeycoder.github.io',
  'http://localhost:5173',
]);

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin =
    requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : 'https://fundermatch.org';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  };
}

async function restQuery(table: string, params: string): Promise<unknown[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`REST ${table} [${res.status}]: ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<unknown[]>;
}

async function restPatch(table: string, params: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${table} [${res.status}]: ${text.slice(0, 300)}`);
  }
}

async function fetchNteeCode(ein: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.organization?.ntee_code || null;
  } catch {
    return null;
  }
}

// Process an array in parallel batches
async function parallelBatch<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('origin'));

  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(body?.batch_size || 200, 500);

    // Count remaining
    const countRows = (await restQuery(
      'recipient_organizations',
      `ntee_code=is.null&funder_count=gte.3&select=ein&limit=1&head=true`,
    )) as unknown[];

    // Fetch batch of recipients needing NTEE codes
    // Prioritize most active orgs first
    const recipients = (await restQuery(
      'recipient_organizations',
      `ntee_code=is.null&funder_count=gte.3&order=funder_count.desc&select=ein&limit=${batchSize}`,
    )) as Array<{ ein: string }>;

    if (recipients.length === 0) {
      return new Response(
        JSON.stringify({ processed: 0, updated: 0, remaining: 0, message: 'All recipients have NTEE codes' }),
        { headers: { ...headers, 'Content-Type': 'application/json' } },
      );
    }

    console.log(`[update-ntee] Processing ${recipients.length} recipients...`);

    let updated = 0;
    let errors = 0;

    // Fetch NTEE codes in parallel (10 concurrent)
    const results = await parallelBatch(recipients, 10, async (r) => {
      const ntee = await fetchNteeCode(r.ein);
      return { ein: r.ein, ntee };
    });

    // Update database
    for (const { ein, ntee } of results) {
      try {
        if (ntee) {
          await restPatch(
            'recipient_organizations',
            `ein=eq.${encodeURIComponent(ein)}`,
            { ntee_code: ntee },
          );
          updated++;
        } else {
          // Mark as checked so we don't re-fetch (use 'UNKNOWN')
          await restPatch(
            'recipient_organizations',
            `ein=eq.${encodeURIComponent(ein)}`,
            { ntee_code: 'UNKNOWN' },
          );
        }
      } catch (e) {
        errors++;
        console.error(`[update-ntee] Error updating ${ein}:`, e);
      }
    }

    // Get remaining count
    const remainingRows = (await restQuery(
      'recipient_organizations',
      `ntee_code=is.null&funder_count=gte.3&select=ein&limit=0`,
    )) as unknown[];

    // Use a count query instead
    const countResult = (await restQuery(
      'recipient_organizations',
      `ntee_code=is.null&funder_count=gte.3&select=ein`,
    )) as unknown[];
    const remaining = countResult.length;

    console.log(`[update-ntee] Done: ${updated} updated, ${errors} errors, ${remaining} remaining`);

    return new Response(
      JSON.stringify({
        processed: recipients.length,
        updated,
        errors,
        remaining,
        message: `Processed ${recipients.length} recipients. ${updated} got NTEE codes. ${remaining} still need processing.`,
      }),
      { headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  } catch (err: unknown) {
    console.error('update-ntee error:', err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : 'Internal server error',
      }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }
});
