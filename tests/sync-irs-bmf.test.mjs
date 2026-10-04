// Unit tests for scripts/sync-irs-bmf.js's pure helpers: the IRS Business
// Master File CSV parsing and the rows it sends to irs_bmf_stage().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvLine, toStageRow, bmfMonth } from '../scripts/sync-irs-bmf.js';

test('CSV fields: plain, quoted with commas, doubled quotes, empty', () => {
  assert.deepEqual(parseCsvLine('a,"b,c",,"say ""hi""",'), ['a', 'b,c', '', 'say "hi"', '']);
  assert.deepEqual(
    parseCsvLine('941569122,"WAYMAKERS,INCORPORATED",% REV DALE MOWRY,FRESNO'),
    ['941569122', 'WAYMAKERS,INCORPORATED', '% REV DALE MOWRY', 'FRESNO'],
  );
});

const rec = {
  EIN: '956195778', NAME: 'LOS ANGELES SOCCER CLUB,INC', CITY: 'N HOLLYWOOD', STATE: 'CA',
  ZIP: '91601-3125', SUBSECTION: '03', FOUNDATION: '16', STATUS: '01', RULING: '202406',
  ASSET_AMT: '3401', INCOME_AMT: '38075', REVENUE_AMT: '34059', NTEE_CD: 'N64',
};

test('a 501(c)(3) record maps to a stage row', () => {
  assert.deepEqual(toStageRow(rec), {
    ein: '956195778', name: 'LOS ANGELES SOCCER CLUB,INC', city: 'N HOLLYWOOD', state: 'CA',
    zip: '91601', ntee_code: 'N64', subsection: '03', foundation_code: '16', status: '01',
    income_amt: 38075, asset_amt: 3401, revenue_amt: 34059, ruling: '202406',
  });
});

test('blank amounts and codes are null', () => {
  const row = toStageRow({ ...rec, INCOME_AMT: '', ASSET_AMT: '', NTEE_CD: '', CITY: '' });
  assert.equal(row.income_amt, null);
  assert.equal(row.asset_amt, null);
  assert.equal(row.ntee_code, null);
  assert.equal(row.city, null);
});

test('other subsections, bad EINs and nameless rows are skipped', () => {
  assert.equal(toStageRow({ ...rec, SUBSECTION: '04' }), null);
  assert.equal(toStageRow({ ...rec, EIN: '12345' }), null);
  assert.equal(toStageRow({ ...rec, NAME: '  ' }), null);
});

test('the release month is the first of the Last-Modified month, in UTC', () => {
  assert.equal(bmfMonth('Mon, 07 Sep 2026 04:11:46 GMT'), '2026-09-01');
  assert.equal(bmfMonth('Wed, 31 Dec 2025 23:59:59 GMT'), '2025-12-01');
  assert.throws(() => bmfMonth('soon'));
});
