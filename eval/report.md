# Ranking Tuning Report

Generated: 2026-03-05T03:12:47.997Z
Cases evaluated: 60 / 60
Funder universe size: 1500
Grant rows in cache: 1000

## Baseline Metrics

- Objective: 0.329655
- Precision@10: 0.0469
- Negative rate@10: 0.0033
- Budget-fit rate: 0.7979
- Oversized rate: 0
- Geo-fit rate: 0.9819

## Recommended Config (Balanced)

- Name: candidate_097
- Objective: 0.347735
- Precision@10: 0.0535
- Negative rate@10: 0.0082
- Budget-fit rate: 0.8755
- Oversized rate: 0
- Geo-fit rate: 0.9835

## Max-Objective Config

- Name: candidate_009
- Objective: 0.363455
- Precision@10: 0.0431
- Negative rate@10: 0.0082
- Budget-fit rate: 0.9801
- Oversized rate: 0
- Geo-fit rate: 0.9835

## Top 3 Configs

### 1. candidate_009
- Objective: 0.363455
- Precision@10: 0.0431
- Oversized rate: 0
- Budget-fit rate: 0.9801

### 2. candidate_306
- Objective: 0.359915
- Precision@10: 0.0365
- Oversized rate: 0
- Budget-fit rate: 0.9773

### 3. candidate_166
- Objective: 0.357165
- Precision@10: 0.0314
- Oversized rate: 0
- Budget-fit rate: 0.9779

## Recommended Weights JSON

```json
{
  "foundationScanLimit": 250,
  "candidateLimit": 120,
  "topGrantAverageN": 6,
  "recencySlope": 0.0429,
  "recencyFloor": 0.5096,
  "baselineMission": 0.5564,
  "baselineLocation": 0.4436,
  "grantMission": 0.4967,
  "grantLocation": 0.1222,
  "grantSize": 0.3811,
  "historyWeightMin": 0.534,
  "historyCoverageBoost": 0.1599,
  "historyWeightMax": 0.6744,
  "historyWeightMaxLimited": 0.5871,
  "sizePenaltyMultiplier": 0.1721,
  "medianBandPenalty": 0.0464,
  "dataCompletenessBonus": 0.0263,
  "fallbackBaselineMultiplier": 0.9489,
  "limitedDataMinGrants": 3,
  "limitedDataMinCompleteness": 0.1882
}
```

