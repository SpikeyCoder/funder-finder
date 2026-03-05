#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import {
  budgetBandFromNumeric,
  createDataset,
  inferBudgetBandFromGrantAmount,
  normalizeState,
  numericBudgetBand,
  parseUserLocation,
  regionForState,
  tokenize,
  normalizeText,
} from './lib/ranker-eval-core.js';

const DEFAULT_SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';

function parseArgs(argv) {
  const args = {
    targetCases: 60,
    outputPath: 'eval/cases.silver.jsonl',
    reviewPath: 'eval/review_queue.jsonl',
    summaryPath: 'eval/cases.summary.json',
    minGrantYear: new Date().getUTCFullYear() - 5,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target-cases') args.targetCases = Number(argv[++i]);
    else if (arg === '--output') args.outputPath = argv[++i];
    else if (arg === '--review-output') args.reviewPath = argv[++i];
    else if (arg === '--summary-output') args.summaryPath = argv[++i];
    else if (arg === '--min-grant-year') args.minGrantYear = Number(argv[++i]);
  }

  return args;
}

function deriveMissionText(grants) {
  const texts = grants
    .map((g) => String(g.purpose_text || g.mission_signal_text || '').trim())
    .filter((text) => text.length >= 20)
    .sort((a, b) => b.length - a.length);

  if (texts.length) return texts[0];

  const fallback = grants
    .map((g) => String(g.mission_signal_text || '').trim())
    .find((text) => text.length > 0);

  if (fallback) return fallback;

  const granteeName = grants[0]?.grantee_name || 'community program';
  return `We deliver mission-driven services that align with the needs of ${granteeName}.`;
}

function deriveKeywords(missionText) {
  const tokens = [...tokenize(missionText)];
  return tokens.slice(0, 5);
}

function pickBudgetBand(grants) {
  const counts = new Map();
  for (const grant of grants) {
    const band = grant.grantee_budget_band ?? inferBudgetBandFromGrantAmount(grant.grant_amount);
    if (Number.isInteger(band)) {
      counts.set(band, (counts.get(band) || 0) + 1);
    }
  }

  if (counts.size > 0) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return budgetBandFromNumeric(top);
  }

  return 'prefer_not_to_say';
}

function sortPositiveFoundationIds(grants) {
  const stats = new Map();

  for (const grant of grants) {
    const id = grant.foundation_id;
    const current = stats.get(id) || { count: 0, latestYear: 0, totalAmount: 0 };
    current.count += 1;
    current.latestYear = Math.max(current.latestYear, grant.grant_year || 0);
    current.totalAmount += Number(grant.grant_amount || 0);
    stats.set(id, current);
  }

  return [...stats.entries()]
    .sort((a, b) => {
      if (b[1].count !== a[1].count) return b[1].count - a[1].count;
      if (b[1].latestYear !== a[1].latestYear) return b[1].latestYear - a[1].latestYear;
      return b[1].totalAmount - a[1].totalAmount;
    })
    .map(([id]) => id)
    .slice(0, 6);
}

function pickNegatives({ dataset, positiveIds, locationServed, budgetBand, count = 6 }) {
  const positives = new Set(positiveIds);
  const userBandNumeric = numericBudgetBand(budgetBand);
  const userLocation = parseUserLocation(locationServed);

  const candidates = dataset.funders
    .filter((funder) => !positives.has(funder.id))
    .map((funder) => {
      const feature = dataset.featuresByFoundation.get(funder.id);
      const medianBand = feature?.median_grantee_budget_band || null;
      const totalGiving = Number(funder.total_giving || 0);
      const funderState = normalizeState(funder.state);
      const userState = normalizeState(userLocation.state);

      let mismatchScore = 0;

      if (userBandNumeric && medianBand && medianBand >= userBandNumeric + 2) mismatchScore += 2.5;
      if (userBandNumeric && !medianBand && totalGiving >= 100_000_000) mismatchScore += 1.5;
      if (!medianBand && !feature?.grants_last_5y_count) mismatchScore += 0.4;

      if (userState && funderState && userState !== funderState) {
        const sameRegion = regionForState(userState) && regionForState(funderState) && regionForState(userState) === regionForState(funderState);
        mismatchScore += sameRegion ? 0.3 : 0.9;
      }

      if (funder.type === 'foundation') mismatchScore += 0.2;

      return {
        id: funder.id,
        mismatchScore,
        totalGiving,
      };
    })
    .sort((a, b) => {
      if (b.mismatchScore !== a.mismatchScore) return b.mismatchScore - a.mismatchScore;
      return b.totalGiving - a.totalGiving;
    })
    .slice(0, count * 4)
    .map((item) => item.id);

  return [...new Set(candidates)].slice(0, count);
}

function confidenceScore({ missionText, locationServed, budgetBand, positives }) {
  let score = 0.55;
  if (missionText && missionText.length >= 20) score += 0.15;
  if (locationServed && locationServed.length >= 2) score += 0.1;
  if (budgetBand && budgetBand !== 'prefer_not_to_say') score += 0.1;
  if (positives.length >= 2) score += 0.08;
  if (positives.length >= 3) score += 0.05;
  return Number(Math.min(score, 0.95).toFixed(2));
}

function chooseLocation(grants) {
  const states = grants
    .map((g) => normalizeState(g.grantee_state))
    .filter(Boolean);

  if (states.length) {
    const state = states[0];
    return state;
  }

  const country = grants.map((g) => String(g.grantee_country || '').toUpperCase()).find(Boolean);
  if (country && country !== 'US' && country !== 'USA') return 'International / Global';
  return 'United States';
}

function groupByGrantee(grants) {
  const groups = new Map();

  for (const grant of grants) {
    const nameKey = normalizeText(grant.grantee_name || 'unknown-grantee');
    const stateKey = normalizeState(grant.grantee_state) || '';
    const key = `${nameKey}||${stateKey}`;

    const group = groups.get(key) || {
      key,
      grants: [],
      grantee_name: grant.grantee_name,
      grantee_state: normalizeState(grant.grantee_state),
    };

    group.grants.push(grant);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function buildCaseFromGroup(group, dataset, index) {
  const sortedGrants = [...group.grants].sort((a, b) => {
    if ((b.grant_year || 0) !== (a.grant_year || 0)) return (b.grant_year || 0) - (a.grant_year || 0);
    return Number(b.grant_amount || 0) - Number(a.grant_amount || 0);
  });

  const missionText = deriveMissionText(sortedGrants);
  const budgetBand = pickBudgetBand(sortedGrants);
  const locationServed = chooseLocation(sortedGrants);
  const positives = sortPositiveFoundationIds(sortedGrants);
  const negatives = pickNegatives({
    dataset,
    positiveIds: positives,
    locationServed,
    budgetBand,
    count: 6,
  });

  const keywords = deriveKeywords(missionText);
  const confidence = confidenceScore({ missionText, locationServed, budgetBand, positives });

  return {
    case_id: `silver_${String(index + 1).padStart(3, '0')}`,
    label_source: 'silver_propublica_grantee_history',
    confidence,
    mission: missionText,
    locationServed,
    budgetBand,
    keywords,
    positives,
    negatives,
    metadata: {
      grantee_name: group.grantee_name,
      grantee_state: group.grantee_state,
      grant_rows: sortedGrants.length,
      foundation_coverage: positives.length,
      latest_grant_year: sortedGrants[0]?.grant_year || null,
    },
  };
}

function rebalanceCases(cases, targetCases) {
  if (cases.length <= targetCases) return cases;

  const buckets = {
    under_250k: [],
    '250k_1m': [],
    '1m_5m': [],
    over_5m: [],
    prefer_not_to_say: [],
  };

  for (const item of cases) {
    const bucket = item.budgetBand in buckets ? item.budgetBand : 'prefer_not_to_say';
    buckets[bucket].push(item);
  }

  Object.values(buckets).forEach((arr) => arr.sort((a, b) => b.confidence - a.confidence));

  const selected = [];
  const perBucket = Math.max(1, Math.floor(targetCases / 4));

  for (const bucketName of ['under_250k', '250k_1m', '1m_5m', 'over_5m']) {
    selected.push(...buckets[bucketName].slice(0, perBucket));
  }

  if (selected.length < targetCases) {
    const used = new Set(selected.map((item) => item.case_id));
    const leftovers = cases.filter((item) => !used.has(item.case_id));
    leftovers.sort((a, b) => b.confidence - a.confidence);
    selected.push(...leftovers.slice(0, targetCases - selected.length));
  }

  return selected.slice(0, targetCases);
}

function toJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;

  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  }

  const dataset = await createDataset({
    supabaseUrl,
    serviceRoleKey,
    minGrantYear: args.minGrantYear,
    foundationLimit: 1200,
  });

  const grouped = groupByGrantee(dataset.grants)
    .filter((group) => String(group.grantee_name || '').trim().length >= 4)
    .sort((a, b) => b.grants.length - a.grants.length);

  const draftCases = grouped.map((group, idx) => buildCaseFromGroup(group, dataset, idx));
  const selectedCases = rebalanceCases(draftCases, args.targetCases)
    .sort((a, b) => b.confidence - a.confidence)
    .map((item, idx) => ({
      ...item,
      case_id: `silver_${String(idx + 1).padStart(3, '0')}`,
    }));

  const reviewQueue = [...selectedCases]
    .sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence - b.confidence;
      return (a.metadata.foundation_coverage || 0) - (b.metadata.foundation_coverage || 0);
    })
    .slice(0, Math.min(20, selectedCases.length));

  const summary = {
    generated_at: new Date().toISOString(),
    source: 'foundation_grants (silver labels)',
    case_count: selectedCases.length,
    grants_rows: dataset.grants.length,
    foundations_in_grants: new Set(dataset.grants.map((g) => g.foundation_id)).size,
    avg_confidence: Number((selectedCases.reduce((sum, c) => sum + c.confidence, 0) / Math.max(1, selectedCases.length)).toFixed(3)),
    budget_band_distribution: selectedCases.reduce((acc, item) => {
      acc[item.budgetBand] = (acc[item.budgetBand] || 0) + 1;
      return acc;
    }, {}),
    location_distribution: selectedCases.reduce((acc, item) => {
      const key = item.locationServed || 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };

  await mkdir('eval', { recursive: true });
  await mkdir('eval/results', { recursive: true });

  await writeFile(args.outputPath, toJsonl(selectedCases), 'utf8');
  await writeFile(args.reviewPath, toJsonl(reviewQueue), 'utf8');
  await writeFile(args.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`Generated ${selectedCases.length} silver-labeled cases.`);
  console.log(`Case file: ${args.outputPath}`);
  console.log(`Review queue: ${args.reviewPath}`);
  console.log(`Summary: ${args.summaryPath}`);
}

main().catch((err) => {
  console.error('build-eval-cases failed:', err.message || err);
  process.exit(1);
});
