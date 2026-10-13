// Unit tests for src/lib/budgetRanges.ts — labels for user_profiles.budget_range,
// which holds both the Settings/Signup ranges and the funder search's bands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/budgetRanges.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { BUDGET_RANGES, profileBudgetLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('Settings and Signup ranges read as their labels', () => {
  for (const range of BUDGET_RANGES) assert.equal(profileBudgetLabel(range.value), range.label);
  assert.equal(profileBudgetLabel('250k-1m'), '$250,000 - $1,000,000');
});

test('funder search bands read as text too', () => {
  assert.equal(profileBudgetLabel('under_250k'), 'Under $250,000');
  assert.equal(profileBudgetLabel('over_5m'), 'Over $5,000,000');
});

test('no budget, prefer not to say, or an unknown value: no label', () => {
  for (const value of [null, undefined, '', 'prefer_not_to_say', 'lots', 'toString', 'constructor', '__proto__']) {
    assert.equal(profileBudgetLabel(value), null, String(value));
  }
});
