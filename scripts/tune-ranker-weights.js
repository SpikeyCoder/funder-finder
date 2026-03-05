#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  createDataset,
  defaultWeights,
  evaluateRanking,
  normalizeState,
  numericBudgetBand,
  parseUserLocation,
  rankFundersForCase,
  regionForState,
} from './lib/ranker-eval-core.js';

const DEFAULT_SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';

function parseArgs(argv) {
  const args = {
    casesPath: 'eval/cases.silver.jsonl',
    outputSummaryPath: 'eval/results/tuning-summary.json',
    outputTopPath: 'eval/results/top-configs.json',
    outputRecommendedPath: 'eval/weights/recommended.json',
    outputReportPath: 'eval/report.md',
    outputEdgeReviewPath: 'eval/results/edge-case-review.json',
    iterations: 320,
    topK: 10,
    seed: 20260305,
    minGrantYear: new Date().getUTCFullYear() - 5,
    foundationLimit: 1200,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cases') args.casesPath = argv[++i];
    else if (arg === '--iterations') args.iterations = Number(argv[++i]);
    else if (arg === '--top-k') args.topK = Number(argv[++i]);
    else if (arg === '--seed') args.seed = Number(argv[++i]);
    else if (arg === '--output-summary') args.outputSummaryPath = argv[++i];
    else if (arg === '--output-top') args.outputTopPath = argv[++i];
    else if (arg === '--output-recommended') args.outputRecommendedPath = argv[++i];
    else if (arg === '--output-report') args.outputReportPath = argv[++i];
    else if (arg === '--output-edge-review') args.outputEdgeReviewPath = argv[++i];
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

function seededRandom(seedInput) {
  let seed = Number(seedInput) || 1;
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function randBetween(rand, min, max) {
  return min + rand() * (max - min);
}

function compactWeights(weights) {
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, Number.isFinite(v) ? Number(v.toFixed(4)) : v]));
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
      geoChecks += 1;
      const foundation = dataset.fundersById.get(result.foundationId);
      const foundationState = normalizeState(foundation?.state);
      const userState = normalizeState(userLocation.state);
      const userRegion = userLocation.region;

      if (userState && foundationState && userState === foundationState) geoHits += 1;
      else if (userRegion && foundationState && regionForState(foundationState) === userRegion) geoHits += 1;
      else if (userLocation.isNationalUS && foundationState) geoHits += 1;
    }
  }

  return {
    budgetFitRate: budgetChecks ? budgetHits / budgetChecks : null,
    oversizedRate: budgetChecks ? oversizedHits / budgetChecks : null,
    geoFitRate: geoChecks ? geoHits / geoChecks : null,
  };
}

function objective(metrics) {
  return (
    metrics.precision_at_k_weighted * 0.5
    + metrics.budget_fit_rate_weighted * 0.2
    + metrics.geo_fit_rate_weighted * 0.15
    - metrics.oversized_rate_weighted * 0.25
    - metrics.negative_rate_at_k_weighted * 0.2
  );
}

function evaluateConfig(dataset, cases, weights, topK) {
  const evalRows = [];

  for (const userCase of cases) {
    const { topResults } = rankFundersForCase(dataset, userCase, weights, { topN: topK });
    const rankedIds = topResults.map((item) => item.foundationId);

    const positivesInUniverse = (userCase.positives || []).filter((id) => dataset.fundersById.has(id));
    if (!positivesInUniverse.length) continue;

    const labels = {
      positives: positivesInUniverse,
      negatives: (userCase.negatives || []).filter((id) => dataset.fundersById.has(id)),
    };

    const baseMetrics = evaluateRanking(labels, rankedIds, topK);
    const extra = budgetAndGeoMetrics({ topResults, dataset, userCase });

    evalRows.push({
      case_id: userCase.case_id,
      weight: Number(userCase.confidence || 0.7),
      precision: baseMetrics.precisionAtK,
      negativeRate: baseMetrics.negativeRateAtK,
      budgetFit: extra.budgetFitRate,
      oversized: extra.oversizedRate,
      geoFit: extra.geoFitRate,
      topResultIds: rankedIds,
    });
  }

  if (!evalRows.length) {
    throw new Error('No cases with positive labels in funder universe for this config.');
  }

  const metricBundle = {
    precision_at_k_weighted: Number(weightedAverage(evalRows, (r) => r.precision).toFixed(4)),
    negative_rate_at_k_weighted: Number(weightedAverage(evalRows, (r) => r.negativeRate).toFixed(4)),
    budget_fit_rate_weighted: Number(weightedAverage(evalRows.filter((r) => r.budgetFit !== null), (r) => r.budgetFit ?? 0).toFixed(4)),
    oversized_rate_weighted: Number(weightedAverage(evalRows.filter((r) => r.oversized !== null), (r) => r.oversized ?? 0).toFixed(4)),
    geo_fit_rate_weighted: Number(weightedAverage(evalRows.filter((r) => r.geoFit !== null), (r) => r.geoFit ?? 0).toFixed(4)),
  };

  return {
    casesEvaluated: evalRows.length,
    metrics: metricBundle,
    objective: Number(objective(metricBundle).toFixed(6)),
    perCase: evalRows,
  };
}

function randomWeightConfig(rand) {
  const base = defaultWeights();

  const baselineMission = randBetween(rand, 0.55, 0.82);
  const baselineLocation = 1 - baselineMission;

  let grantMission = 0;
  let grantLocation = 0;
  let grantSize = 0;

  for (let tries = 0; tries < 30; tries += 1) {
    grantMission = randBetween(rand, 0.35, 0.62);
    grantLocation = randBetween(rand, 0.12, 0.35);
    grantSize = 1 - grantMission - grantLocation;
    if (grantSize >= 0.12 && grantSize <= 0.45) break;
  }

  return {
    ...base,
    baselineMission,
    baselineLocation,
    grantMission,
    grantLocation,
    grantSize,
    historyWeightMin: randBetween(rand, 0.42, 0.66),
    historyCoverageBoost: randBetween(rand, 0.1, 0.34),
    historyWeightMax: randBetween(rand, 0.62, 0.9),
    historyWeightMaxLimited: randBetween(rand, 0.32, 0.6),
    sizePenaltyMultiplier: randBetween(rand, 0.16, 0.4),
    medianBandPenalty: randBetween(rand, 0.02, 0.12),
    dataCompletenessBonus: randBetween(rand, 0.02, 0.14),
    recencySlope: randBetween(rand, 0.04, 0.12),
    recencyFloor: randBetween(rand, 0.5, 0.75),
    fallbackBaselineMultiplier: randBetween(rand, 0.88, 0.98),
    limitedDataMinCompleteness: randBetween(rand, 0.15, 0.34),
  };
}

function toMarkdownReport({
  summary,
  baseline,
  recommendedBalanced,
  recommendedMaxObjective,
  topConfigs,
}) {
  const m = [];
  m.push('# Ranking Tuning Report');
  m.push('');
  m.push(`Generated: ${summary.generated_at}`);
  m.push(`Cases evaluated: ${summary.case_count_evaluated} / ${summary.case_count_total}`);
  m.push(`Funder universe size: ${summary.funder_universe_size}`);
  m.push(`Grant rows in cache: ${summary.grant_rows}`);
  m.push('');
  m.push('## Baseline Metrics');
  m.push('');
  m.push(`- Objective: ${baseline.objective}`);
  m.push(`- Precision@${summary.top_k}: ${baseline.metrics.precision_at_k_weighted}`);
  m.push(`- Negative rate@${summary.top_k}: ${baseline.metrics.negative_rate_at_k_weighted}`);
  m.push(`- Budget-fit rate: ${baseline.metrics.budget_fit_rate_weighted}`);
  m.push(`- Oversized rate: ${baseline.metrics.oversized_rate_weighted}`);
  m.push(`- Geo-fit rate: ${baseline.metrics.geo_fit_rate_weighted}`);
  m.push('');
  m.push('## Recommended Config (Balanced)');
  m.push('');
  m.push(`- Name: ${recommendedBalanced.name}`);
  m.push(`- Objective: ${recommendedBalanced.objective}`);
  m.push(`- Precision@${summary.top_k}: ${recommendedBalanced.metrics.precision_at_k_weighted}`);
  m.push(`- Negative rate@${summary.top_k}: ${recommendedBalanced.metrics.negative_rate_at_k_weighted}`);
  m.push(`- Budget-fit rate: ${recommendedBalanced.metrics.budget_fit_rate_weighted}`);
  m.push(`- Oversized rate: ${recommendedBalanced.metrics.oversized_rate_weighted}`);
  m.push(`- Geo-fit rate: ${recommendedBalanced.metrics.geo_fit_rate_weighted}`);
  m.push('');
  m.push('## Max-Objective Config');
  m.push('');
  m.push(`- Name: ${recommendedMaxObjective.name}`);
  m.push(`- Objective: ${recommendedMaxObjective.objective}`);
  m.push(`- Precision@${summary.top_k}: ${recommendedMaxObjective.metrics.precision_at_k_weighted}`);
  m.push(`- Negative rate@${summary.top_k}: ${recommendedMaxObjective.metrics.negative_rate_at_k_weighted}`);
  m.push(`- Budget-fit rate: ${recommendedMaxObjective.metrics.budget_fit_rate_weighted}`);
  m.push(`- Oversized rate: ${recommendedMaxObjective.metrics.oversized_rate_weighted}`);
  m.push(`- Geo-fit rate: ${recommendedMaxObjective.metrics.geo_fit_rate_weighted}`);
  m.push('');
  m.push('## Top 3 Configs');
  m.push('');
  topConfigs.slice(0, 3).forEach((cfg, idx) => {
    m.push(`### ${idx + 1}. ${cfg.name}`);
    m.push(`- Objective: ${cfg.objective}`);
    m.push(`- Precision@${summary.top_k}: ${cfg.metrics.precision_at_k_weighted}`);
    m.push(`- Oversized rate: ${cfg.metrics.oversized_rate_weighted}`);
    m.push(`- Budget-fit rate: ${cfg.metrics.budget_fit_rate_weighted}`);
    m.push('');
  });

  m.push('## Recommended Weights JSON');
  m.push('');
  m.push('```json');
  m.push(JSON.stringify(recommendedBalanced.weights, null, 2));
  m.push('```');
  m.push('');

  return m.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
  }

  const casesContent = await readFile(args.casesPath, 'utf8');
  const cases = parseJsonl(casesContent);
  if (!cases.length) {
    throw new Error(`No cases found in ${args.casesPath}`);
  }

  const dataset = await createDataset({
    supabaseUrl,
    serviceRoleKey,
    minGrantYear: args.minGrantYear,
    foundationLimit: args.foundationLimit,
  });

  const baselineWeights = defaultWeights();
  const baselineEval = evaluateConfig(dataset, cases, baselineWeights, args.topK);

  const rand = seededRandom(args.seed);
  const attempts = [];

  for (let i = 0; i < args.iterations; i += 1) {
    const weights = compactWeights(randomWeightConfig(rand));
    const evalResult = evaluateConfig(dataset, cases, weights, args.topK);
    attempts.push({
      name: `candidate_${String(i + 1).padStart(3, '0')}`,
      objective: evalResult.objective,
      casesEvaluated: evalResult.casesEvaluated,
      metrics: evalResult.metrics,
      weights,
    });
  }

  const sortedCandidates = attempts.sort((a, b) => b.objective - a.objective);
  const topCandidates = sortedCandidates.slice(0, 8);
  const bestObjective = topCandidates[0];

  const baselinePrecision = baselineEval.metrics.precision_at_k_weighted;
  const baselineNegativeRate = baselineEval.metrics.negative_rate_at_k_weighted;
  const precisionFloor = baselinePrecision - 0.0005;
  const negativeRateCeiling = baselineNegativeRate + 0.01;
  const balancedCandidates = sortedCandidates.filter(
    (candidate) =>
      candidate.metrics.precision_at_k_weighted >= precisionFloor
      && candidate.metrics.negative_rate_at_k_weighted <= negativeRateCeiling,
  );
  const bestBalanced = balancedCandidates[0] || {
    name: 'baseline',
    objective: baselineEval.objective,
    casesEvaluated: baselineEval.casesEvaluated,
    metrics: baselineEval.metrics,
    weights: compactWeights(baselineWeights),
  };

  const configsForEdgeReview = [
    { name: 'baseline', weights: compactWeights(baselineWeights), ...baselineEval },
    ...topCandidates.slice(0, 3).map((candidate) => ({
      name: candidate.name,
      weights: candidate.weights,
      objective: candidate.objective,
      metrics: candidate.metrics,
      casesEvaluated: candidate.casesEvaluated,
    })),
  ];

  const edgeCases = [...cases]
    .sort((a, b) => (a.confidence || 0.7) - (b.confidence || 0.7))
    .slice(0, Math.min(12, cases.length));

  const edgeReview = edgeCases.map((edgeCase) => {
    const configComparisons = configsForEdgeReview.map((config) => {
      const { topResults } = rankFundersForCase(dataset, edgeCase, config.weights, { topN: args.topK });
      return {
        config: config.name,
        top_result_ids: topResults.slice(0, 5).map((row) => row.foundationId),
        top_result_names: topResults.slice(0, 5).map((row) => row.foundationName),
      };
    });

    return {
      case_id: edgeCase.case_id,
      confidence: edgeCase.confidence,
      mission: edgeCase.mission,
      locationServed: edgeCase.locationServed,
      budgetBand: edgeCase.budgetBand,
      positives: edgeCase.positives,
      negatives: edgeCase.negatives,
      comparisons: configComparisons,
    };
  });

  const summary = {
    generated_at: new Date().toISOString(),
    seed: args.seed,
    iterations: args.iterations,
    top_k: args.topK,
    cases_file: args.casesPath,
    case_count_total: cases.length,
    case_count_evaluated: baselineEval.casesEvaluated,
    funder_universe_size: dataset.funders.length,
    grant_rows: dataset.grants.length,
    baseline: {
      objective: baselineEval.objective,
      metrics: baselineEval.metrics,
      weights: compactWeights(baselineWeights),
    },
    recommended: bestBalanced,
    recommended_balanced: bestBalanced,
    recommended_max_objective: bestObjective,
    top_configs: topCandidates,
  };

  await mkdir('eval/results', { recursive: true });
  await mkdir('eval/weights', { recursive: true });

  await writeFile(args.outputSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(args.outputTopPath, `${JSON.stringify(topCandidates, null, 2)}\n`, 'utf8');
  await writeFile(args.outputRecommendedPath, `${JSON.stringify(bestBalanced.weights, null, 2)}\n`, 'utf8');
  await writeFile(args.outputEdgeReviewPath, `${JSON.stringify(edgeReview, null, 2)}\n`, 'utf8');

  const report = toMarkdownReport({
    summary,
    baseline: summary.baseline,
    recommendedBalanced: bestBalanced,
    recommendedMaxObjective: bestObjective,
    topConfigs: topCandidates,
  });
  await writeFile(args.outputReportPath, `${report}\n`, 'utf8');

  console.log(`Tuning complete. ${args.iterations} configs evaluated.`);
  console.log(`Baseline objective: ${summary.baseline.objective}`);
  console.log(`Recommended balanced objective: ${bestBalanced.objective}`);
  console.log(`Max objective candidate: ${bestObjective.objective}`);
  console.log(`Recommended weights: ${args.outputRecommendedPath}`);
  console.log(`Report: ${args.outputReportPath}`);
}

main().catch((err) => {
  console.error('tune-ranker-weights failed:', err.message || err);
  process.exit(1);
});
