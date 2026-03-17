#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  createDataset,
  evaluateRanking,
  normalizeState,
  numericBudgetBand,
  parseUserLocation,
  rankFundersForCase,
  regionForState,
  defaultWeights,
} from './lib/ranker-eval-core.js';

const DEFAULT_SUPABASE_URL = 'https://auth.fundermatch.org';

function parseArgs(argv) {
  const args = {
    casesPath: 'eval/cases.silver.jsonl',
    outputPath: 'eval/results/eval-latest.json',
    tracesPath: 'eval/results/traces-latest.jsonl',
    weightsPath: null,
    topK: 10,
    minGrantYear: new Date().getUTCFullYear() - 5,
    foundationLimit: 1200,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cases') args.casesPath = argv[++i];
    else if (arg === '--output') args.outputPath = argv[++i];
    else if (arg === '--traces-output') args.tracesPath = argv[++i];
    else if (arg === '--weights') args.weightsPath = argv[++i];
    else if (arg === '--top-k') args.topK = Number(argv[++i]);
    else if (arg === '--min-grant-year') args.minGrantYear = Number(argv[++i]);
    else if (arg === '--foundation-limit') args.foundationLimit = Number(argv[++i]);
  }

  return args;
}

function parseJsonl(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function weightedAverage(rows, getter) {
  const numerator = rows.reduce((sum, row) => sum + getter(row) * row.weight, 0);
  const denominator = rows.reduce((sum, row) => sum + row.weight, 0);
  return denominator ? numerator / denominator : 0;
}

function budgetAndGeoMetrics({ topResults, dataset, userCase }) {
  const userBand = numericBudgetBand(userCase.budgetBand || 'prefer_not_to_say');
  const userLocation = parseUserLocation(userCase.locationServed);

  let budgetChecks = 0;
  let budgetHits = 0;
  let oversizedHits = 0;

  let geoChecks = 0;
  let geoHits = 0;

  for (const result of topResults) {
    const feature = dataset.featuresByFoundation.get(result.foundationId);
    const medianBand = feature?.median_grantee_budget_band || null;

    if (userBand && medianBand) {
      budgetChecks += 1;
      const diff = Math.abs(userBand - medianBand);
      if (diff <= 1) budgetHits += 1;
      if (medianBand >= userBand + 2) oversizedHits += 1;
    }

    if (userLocation.hasLocationInput) {
      const foundation = dataset.fundersById.get(result.foundationId);
      const foundationState = normalizeState(foundation?.state);
      const userState = normalizeState(userLocation.state);
      const userRegion = userLocation.region;
      geoChecks += 1;

      if (userState && foundationState && userState === foundationState) geoHits += 1;
      else if (userRegion && foundationState && regionForState(foundationState) === userRegion) geoHits += 1;
      else if (userLocation.isNationalUS && foundationState) geoHits += 1;
    }
  }

  return {
    budgetFitRate: budgetChecks ? budgetHits / budgetChecks : null,
    oversizedRate: budgetChecks ? oversizedHits / budgetChecks : null,
    geoFitRate: geoChecks ? geoHits / geoChecks : null,
    budgetChecks,
    geoChecks,
  };
}

function compactWeights(weights) {
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Number.isFinite(v) ? Number(v.toFixed(4)) : v]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  }

  const casesRaw = await readFile(args.casesPath, 'utf8');
  const cases = parseJsonl(casesRaw);
  if (!cases.length) throw new Error(`No cases found in ${args.casesPath}`);

  let weights = defaultWeights();
  if (args.weightsPath) {
    const raw = await readFile(args.weightsPath, 'utf8');
    weights = { ...weights, ...JSON.parse(raw) };
  }

  const dataset = await createDataset({
    supabaseUrl,
    serviceRoleKey,
    minGrantYear: args.minGrantYear,
    foundationLimit: args.foundationLimit,
  });

  const evaluations = [];
  const traces = [];

  for (const userCase of cases) {
    const { topResults } = rankFundersForCase(dataset, userCase, weights, { topN: args.topK });
    const rankedIds = topResults.map((row) => row.foundationId);

    const positivesInUniverse = (userCase.positives || []).filter((id) => dataset.fundersById.has(id));
    const labelsForEval = {
      positives: positivesInUniverse,
      negatives: (userCase.negatives || []).filter((id) => dataset.fundersById.has(id)),
    };

    const metrics = evaluateRanking(labelsForEval, rankedIds, args.topK);
    const extra = budgetAndGeoMetrics({ topResults, dataset, userCase });

    const row = {
      case_id: userCase.case_id,
      weight: Number(userCase.confidence || 0.7),
      confidence: Number(userCase.confidence || 0.7),
      positives_total: (userCase.positives || []).length,
      positives_in_universe: positivesInUniverse.length,
      precision_at_k: metrics.precisionAtK,
      negative_rate_at_k: metrics.negativeRateAtK,
      budget_fit_rate: extra.budgetFitRate,
      oversized_rate: extra.oversizedRate,
      geo_fit_rate: extra.geoFitRate,
      top_result_ids: rankedIds,
      top_result_names: topResults.map((item) => item.foundationName),
    };

    evaluations.push(row);

    traces.push({
      case_id: userCase.case_id,
      confidence: row.confidence,
      mission: userCase.mission,
      locationServed: userCase.locationServed,
      budgetBand: userCase.budgetBand,
      positives: userCase.positives,
      negatives: userCase.negatives,
      top_results: topResults.map((item) => ({
        foundationId: item.foundationId,
        foundationName: item.foundationName,
        fitScore: Number(item.fitScore.toFixed(4)),
        baseline: Number(item.baseline.toFixed(4)),
        historyScore: Number(item.historyScore.toFixed(4)),
        historyWeight: Number(item.historyWeight.toFixed(4)),
        dataCompleteness: Number(item.dataCompleteness.toFixed(4)),
        sizePenalty: Number(item.sizePenalty.toFixed(4)),
        limitedGrantHistoryData: item.limitedGrantHistoryData,
        topSimilarGrantees: item.topSimilarGrantees,
      })),
    });
  }

  const evalRows = evaluations.filter((row) => row.positives_in_universe > 0);
  if (!evalRows.length) {
    throw new Error('No evaluation rows with positive labels inside current ranking universe.');
  }

  const summary = {
    generated_at: new Date().toISOString(),
    cases_file: args.casesPath,
    case_count_total: cases.length,
    case_count_evaluated: evalRows.length,
    supabase_url: supabaseUrl,
    funder_universe_size: dataset.funders.length,
    grant_rows: dataset.grants.length,
    weights: compactWeights(weights),
    metrics: {
      precision_at_k_weighted: Number(weightedAverage(evalRows, (r) => r.precision_at_k).toFixed(4)),
      negative_rate_at_k_weighted: Number(weightedAverage(evalRows, (r) => r.negative_rate_at_k).toFixed(4)),
      budget_fit_rate_weighted: Number(weightedAverage(evalRows.filter((r) => r.budget_fit_rate !== null), (r) => r.budget_fit_rate ?? 0).toFixed(4)),
      oversized_rate_weighted: Number(weightedAverage(evalRows.filter((r) => r.oversized_rate !== null), (r) => r.oversized_rate ?? 0).toFixed(4)),
      geo_fit_rate_weighted: Number(weightedAverage(evalRows.filter((r) => r.geo_fit_rate !== null), (r) => r.geo_fit_rate ?? 0).toFixed(4)),
    },
    cases_without_positive_coverage: evaluations.filter((row) => row.positives_in_universe === 0).map((row) => row.case_id),
    per_case: evaluations,
  };

  await mkdir('eval/results', { recursive: true });
  await writeFile(args.outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(args.tracesPath, traces.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

  console.log(`Evaluated ${evalRows.length}/${cases.length} cases.`);
  console.log(`Precision@${args.topK} (weighted): ${summary.metrics.precision_at_k_weighted}`);
  console.log(`Oversized rate (weighted): ${summary.metrics.oversized_rate_weighted}`);
  console.log(`Output: ${args.outputPath}`);
  console.log(`Traces: ${args.tracesPath}`);
}

main().catch((err) => {
  console.error('eval-ranker failed:', err.message || err);
  process.exit(1);
});
