#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://auth.fundermatch.org';

function parseArgs(argv) {
  const args = {
    outputPath: 'eval/labels/search-signal-labels.jsonl',
    outputSummaryPath: 'eval/labels/search-signal-summary.json',
    days: 30,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output') args.outputPath = argv[++i];
    else if (arg === '--output-summary') args.outputSummaryPath = argv[++i];
    else if (arg === '--days') args.days = Number(argv[++i]);
  }
  return args;
}

function toJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

async function fetchPaged(client, table, select, filters = [], order = null) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];

  while (true) {
    let query = client.from(table).select(select).range(from, from + pageSize - 1);
    for (const fn of filters) query = fn(query);
    if (order) query = query.order(order.column, { ascending: order.ascending });
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const sinceIso = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000).toISOString();

  const labels = await fetchPaged(
    supabase,
    'search_signal_training_labels_v1',
    'search_run_id,mission_hash,budget_band,location_served,keywords,foundation_id,foundation_rank,saved_signal,outbound_signal,detail_signal,relevance_label,first_seen_at,last_seen_at',
    [(q) => q.gte('last_seen_at', sinceIso)],
    { column: 'last_seen_at', ascending: false },
  );

  const events = await fetchPaged(
    supabase,
    'search_signal_events',
    'search_run_id,event_type,created_at',
    [
      (q) => q.gte('created_at', sinceIso),
      (q) => q.in('event_type', ['search_results_loaded', 'result_saved', 'result_outbound_click', 'result_view_details']),
    ],
    { column: 'created_at', ascending: false },
  );

  await mkdir('eval/labels', { recursive: true });
  await writeFile(args.outputPath, `${toJsonl(labels)}\n`, 'utf8');

  const summary = {
    generated_at: new Date().toISOString(),
    days: args.days,
    since: sinceIso,
    supabase_url: supabaseUrl,
    label_rows: labels.length,
    event_rows: events.length,
    unique_search_runs: new Set(labels.map((row) => row.search_run_id)).size,
    positive_rows: labels.filter((row) => Number(row.relevance_label || 0) >= 0.6).length,
  };
  await writeFile(args.outputSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`Exported ${labels.length} label rows to ${args.outputPath}`);
  console.log(`Summary: ${args.outputSummaryPath}`);
}

main().catch((err) => {
  console.error('export-search-signal-labels failed:', err.message || err);
  process.exit(1);
});
