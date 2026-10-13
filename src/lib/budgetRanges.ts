import { BudgetBand } from '../types';

// Annual budget ranges as Settings and Signup offer them (user_profiles.budget_range).
export const BUDGET_RANGES = [
  { value: '0-250k', label: 'Under $250,000' },
  { value: '250k-1m', label: '$250,000 - $1,000,000' },
  { value: '1m-5m', label: '$1,000,000 - $5,000,000' },
  { value: '5m-10m', label: '$5,000,000 - $10,000,000' },
  { value: '10m-50m', label: '$10,000,000 - $50,000,000' },
  { value: '50m+', label: '$50,000,000+' },
];

// The funder search (MissionInput) stores its own bands (BudgetBand) in the same column.
const BUDGET_BAND_RANGES: Record<Exclude<BudgetBand, 'prefer_not_to_say'>, string> = {
  under_250k: 'Under $250,000',
  '250k_1m': '$250,000 - $1,000,000',
  '1m_5m': '$1,000,000 - $5,000,000',
  over_5m: 'Over $5,000,000',
};

/** A user_profiles.budget_range value as text, from either vocabulary; null if unknown. */
export function profileBudgetLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return BUDGET_RANGES.find((range) => range.value === value)?.label
    ?? (BUDGET_BAND_RANGES as Record<string, string>)[value] ?? null;
}
