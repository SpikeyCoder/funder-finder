# Ranker Evaluation and Tuning

This folder contains the offline evaluation harness for funder ranking.

## Outputs

- `cases.silver.jsonl`: auto-generated silver-labeled test set (30-100 cases)
- `review_queue.jsonl`: lowest-confidence cases for human QA
- `cases.summary.json`: dataset coverage summary
- `results/eval-latest.json`: metric run for a given weight set
- `results/traces-latest.jsonl`: per-case top result traces with score factors
- `results/tuning-summary.json`: baseline vs tuned comparison
- `results/top-configs.json`: top candidate weight sets
- `weights/recommended.json`: selected weight set from tuning
- `report.md`: markdown summary for decision-making

## Run

1. Build labeled cases

```bash
SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=https://tgtotjvdubhjxzybmdex.supabase.co npm run eval:build-cases
```

2. Evaluate baseline

```bash
SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=https://tgtotjvdubhjxzybmdex.supabase.co npm run eval:ranker -- --weights eval/weights/baseline.json
```

3. Tune weights

```bash
SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=https://tgtotjvdubhjxzybmdex.supabase.co npm run eval:tune -- --iterations 320
```

## Metrics

- `precision_at_k_weighted`
- `negative_rate_at_k_weighted`
- `budget_fit_rate_weighted`
- `oversized_rate_weighted`
- `geo_fit_rate_weighted`

All aggregate metrics are confidence-weighted by case.
