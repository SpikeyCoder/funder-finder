/**
 * migrationParsers.ts
 *
 * Client-side parsers for importing data from external grant platforms
 * (Instrumentl, Candid/Foundation Directory, GrantStation) and generic CSV/Excel.
 *
 * Each parser normalizes rows into a common ImportedRecord shape that maps
 * cleanly onto FunderMatch's saved_funders + tracked_grants data model.
 */

import Papa from 'papaparse';
import * as XLSX from 'xlsx';

// ── Normalised import record ────────────────────────────────────────────────

export type SourcePlatform = 'instrumentl' | 'candid' | 'grantstation' | 'generic_csv';

export interface ImportedRecord {
  /** Best-effort EIN extracted from the source (may be null). */
  ein: string | null;
  /** Funder / foundation name. */
  funderName: string;
  /** Optional grant or opportunity title. */
  grantTitle: string | null;
  /** Mapped to FunderMatch status: researching | applied | awarded | passed */
  status: 'researching' | 'applied' | 'awarded' | 'passed';
  /** Dollar amount (requested or awarded). */
  amount: number | null;
  /** Deadline as ISO date string. */
  deadline: string | null;
  /** Free-text notes aggregated from multiple source columns. */
  notes: string;
  /** URL to the grant or funder on the source platform. */
  grantUrl: string | null;
  /** Location (city/state). */
  city: string | null;
  state: string | null;
  /** Focus areas / program areas. */
  focusAreas: string[];
  /** Total giving (for funder-level imports like Candid). */
  totalGiving: number | null;
  /** Total assets (for funder-level imports like Candid). */
  assetAmount: number | null;
  /** Website URL. */
  website: string | null;
  /** Contact info. */
  contactName: string | null;
  contactEmail: string | null;
  /** Source platform that produced this record. */
  source: SourcePlatform;
  /** Raw row data for debugging / preview. */
  _raw: Record<string, string>;
}

// ── Header fingerprints for auto-detection ──────────────────────────────────

/** Each platform is identified by a set of "must-have" header keywords. */
const PLATFORM_SIGNATURES: { platform: SourcePlatform; required: string[]; bonus: string[] }[] = [
  {
    platform: 'instrumentl',
    required: ['funder name'],
    bonus: ['instrumentl', 'fiscal year', 'grant name', 'match', 'saved', 'tracker status'],
  },
  {
    platform: 'candid',
    required: ['ein'],
    bonus: ['foundation type', 'total giving', 'total assets', 'ntee', 'candid', 'foundation name', 'organization name'],
  },
  {
    platform: 'grantstation',
    required: ['funder name'],
    bonus: ['grantstation', 'program title', 'eligibility', 'geographic focus', 'deadline date'],
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

export interface ParseResult {
  platform: SourcePlatform;
  records: ImportedRecord[];
  headers: string[];
  errors: string[];
}

/**
 * Parse a user-uploaded file (CSV or Excel) and return normalised records.
 * Automatically detects the source platform from column headers.
 */
export async function parseImportFile(file: File): Promise<ParseResult> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  let rawRows: Record<string, string>[];
  let headers: string[];

  if (ext === 'csv' || ext === 'tsv') {
    const result = await parseCsv(file);
    rawRows = result.rows;
    headers = result.headers;
  } else if (['xlsx', 'xls'].includes(ext)) {
    const result = await parseExcel(file);
    rawRows = result.rows;
    headers = result.headers;
  } else {
    return { platform: 'generic_csv', records: [], headers: [], errors: [`Unsupported file type: .${ext}. Please upload CSV, TSV, XLS, or XLSX.`] };
  }

  if (rawRows.length === 0) {
    return { platform: 'generic_csv', records: [], headers, errors: ['File contains no data rows.'] };
  }

  const platform = detectPlatform(headers);
  const errors: string[] = [];
  const records: ImportedRecord[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    try {
      const rec = normalizeRow(rawRows[i], platform, headers);
      if (rec) records.push(rec);
    } catch (e: any) {
      errors.push(`Row ${i + 2}: ${e.message || 'Parse error'}`);
    }
  }

  return { platform, records, headers, errors };
}

/**
 * Detect which platform the file came from based on column headers.
 */
export function detectPlatform(headers: string[]): SourcePlatform {
  const lower = headers.map(h => h.toLowerCase().trim());

  let bestPlatform: SourcePlatform = 'generic_csv';
  let bestScore = 0;

  for (const sig of PLATFORM_SIGNATURES) {
    const hasAllRequired = sig.required.every(req =>
      lower.some(h => h.includes(req))
    );
    if (!hasAllRequired) continue;

    const bonusScore = sig.bonus.filter(b =>
      lower.some(h => h.includes(b))
    ).length;

    const score = sig.required.length * 10 + bonusScore;
    if (score > bestScore) {
      bestScore = score;
      bestPlatform = sig.platform;
    }
  }

  return bestPlatform;
}

// ── CSV / Excel low-level parsers ───────────────────────────────────────────

function parseCsv(file: File): Promise<{ rows: Record<string, string>[]; headers: string[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      complete(results) {
        const rows = (results.data as Record<string, string>[]).filter(row =>
          Object.values(row).some(v => v && v.trim())
        );
        const headers = results.meta.fields ?? [];
        resolve({ rows, headers });
      },
      error(err: Error) {
        reject(err);
      },
    });
  });
}

async function parseExcel(file: File): Promise<{ rows: Record<string, string>[]; headers: string[] }> {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const json: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  // Ensure all values are strings
  const rows = json.map(row => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.trim()] = v instanceof Date ? v.toISOString().split('T')[0] : String(v ?? '');
    }
    return out;
  }).filter(row => Object.values(row).some(v => v.trim()));

  const headers = json.length > 0 ? Object.keys(json[0]).map(h => h.trim()) : [];
  return { rows, headers };
}

// ── Row normalisation per platform ──────────────────────────────────────────

function normalizeRow(
  row: Record<string, string>,
  platform: SourcePlatform,
  _headers: string[],
): ImportedRecord | null {
  switch (platform) {
    case 'instrumentl': return normalizeInstrumentl(row);
    case 'candid': return normalizeCandid(row);
    case 'grantstation': return normalizeGrantStation(row);
    default: return normalizeGeneric(row);
  }
}

// ── Instrumentl ─────────────────────────────────────────────────────────────

function normalizeInstrumentl(row: Record<string, string>): ImportedRecord | null {
  const funderName = col(row, 'funder name') || col(row, 'funder');
  if (!funderName) return null;

  const rawStatus = (col(row, 'tracker status') || col(row, 'status') || '').toLowerCase();

  return {
    ein: cleanEin(col(row, 'ein') || col(row, 'funder ein')),
    funderName,
    grantTitle: col(row, 'grant name') || col(row, 'opportunity name') || null,
    status: mapInstrumentlStatus(rawStatus),
    amount: parseDollar(col(row, 'amount') || col(row, 'award amount') || col(row, 'requested amount')),
    deadline: parseDate(col(row, 'deadline') || col(row, 'next deadline') || col(row, 'due date')),
    notes: buildNotes([
      { label: 'Project', value: col(row, 'instrumentl project name') || col(row, 'project') },
      { label: 'Fiscal Year', value: col(row, 'fiscal year') },
      { label: 'Notes', value: col(row, 'notes') },
      { label: 'Tags', value: col(row, 'tags') },
    ]),
    grantUrl: col(row, 'url') || col(row, 'grant url') || col(row, 'link') || null,
    city: null,
    state: col(row, 'state') || null,
    focusAreas: splitAreas(col(row, 'focus areas') || col(row, 'categories')),
    totalGiving: null,
    assetAmount: null,
    website: col(row, 'website') || null,
    contactName: col(row, 'contact') || col(row, 'contact name') || null,
    contactEmail: col(row, 'contact email') || col(row, 'email') || null,
    source: 'instrumentl',
    _raw: row,
  };
}

function mapInstrumentlStatus(s: string): ImportedRecord['status'] {
  if (/awarded|won|funded|approved/i.test(s)) return 'awarded';
  if (/applied|submitted|pending|in.?review|under.?review/i.test(s)) return 'applied';
  if (/declined|rejected|not.?funded|passed|lost/i.test(s)) return 'passed';
  return 'researching';
}

// ── Candid / Foundation Directory ───────────────────────────────────────────

function normalizeCandid(row: Record<string, string>): ImportedRecord | null {
  const funderName = col(row, 'foundation name') || col(row, 'organization name') || col(row, 'name');
  if (!funderName) return null;

  return {
    ein: cleanEin(col(row, 'ein') || col(row, 'fein')),
    funderName,
    grantTitle: null,
    status: 'researching',
    amount: null,
    deadline: null,
    notes: buildNotes([
      { label: 'Foundation Type', value: col(row, 'foundation type') || col(row, 'type') },
      { label: 'NTEE Code', value: col(row, 'ntee code') || col(row, 'ntee') },
      { label: 'Description', value: col(row, 'description') || col(row, 'purpose') },
      { label: 'Limitations', value: col(row, 'limitations') || col(row, 'application info') },
    ]),
    grantUrl: col(row, 'profile url') || col(row, 'candid url') || null,
    city: col(row, 'city') || null,
    state: col(row, 'state') || null,
    focusAreas: splitAreas(col(row, 'fields of interest') || col(row, 'subject') || col(row, 'program areas')),
    totalGiving: parseDollar(col(row, 'total giving') || col(row, 'total grants paid')),
    assetAmount: parseDollar(col(row, 'total assets') || col(row, 'assets')),
    website: col(row, 'website') || col(row, 'url') || null,
    contactName: col(row, 'contact name') || col(row, 'officer name') || col(row, 'contact person') || null,
    contactEmail: col(row, 'email') || col(row, 'contact email') || null,
    source: 'candid',
    _raw: row,
  };
}

// ── GrantStation ────────────────────────────────────────────────────────────

function normalizeGrantStation(row: Record<string, string>): ImportedRecord | null {
  const funderName = col(row, 'funder name') || col(row, 'organization') || col(row, 'grantor');
  if (!funderName) return null;

  return {
    ein: cleanEin(col(row, 'ein')),
    funderName,
    grantTitle: col(row, 'program title') || col(row, 'grant title') || col(row, 'program name') || null,
    status: 'researching',
    amount: parseDollar(col(row, 'amount') || col(row, 'grant amount') || col(row, 'maximum award')),
    deadline: parseDate(col(row, 'deadline') || col(row, 'deadline date') || col(row, 'due date')),
    notes: buildNotes([
      { label: 'Eligibility', value: col(row, 'eligibility') },
      { label: 'Geographic Focus', value: col(row, 'geographic focus') || col(row, 'geographic area') },
      { label: 'Description', value: col(row, 'description') || col(row, 'summary') },
      { label: 'Requirements', value: col(row, 'requirements') },
    ]),
    grantUrl: col(row, 'url') || col(row, 'website') || col(row, 'link') || null,
    city: col(row, 'city') || null,
    state: col(row, 'state') || null,
    focusAreas: splitAreas(col(row, 'focus areas') || col(row, 'categories') || col(row, 'subject areas')),
    totalGiving: null,
    assetAmount: null,
    website: col(row, 'website') || col(row, 'url') || null,
    contactName: col(row, 'contact') || col(row, 'contact name') || null,
    contactEmail: col(row, 'email') || col(row, 'contact email') || null,
    source: 'grantstation',
    _raw: row,
  };
}

// ── Generic CSV ─────────────────────────────────────────────────────────────

function normalizeGeneric(row: Record<string, string>): ImportedRecord | null {
  const funderName =
    col(row, 'funder name') || col(row, 'funder') || col(row, 'foundation name') ||
    col(row, 'foundation') || col(row, 'organization name') || col(row, 'organization') ||
    col(row, 'grantor') || col(row, 'name');
  if (!funderName) return null;

  const rawStatus = (col(row, 'status') || '').toLowerCase();

  return {
    ein: cleanEin(col(row, 'ein') || col(row, 'fein') || col(row, 'tax id')),
    funderName,
    grantTitle: col(row, 'grant name') || col(row, 'grant title') || col(row, 'program') || col(row, 'opportunity') || null,
    status: mapGenericStatus(rawStatus),
    amount: parseDollar(col(row, 'amount') || col(row, 'grant amount') || col(row, 'award') || col(row, 'ask amount')),
    deadline: parseDate(col(row, 'deadline') || col(row, 'due date') || col(row, 'due')),
    notes: buildNotes([
      { label: 'Notes', value: col(row, 'notes') || col(row, 'comments') },
      { label: 'Description', value: col(row, 'description') },
    ]),
    grantUrl: col(row, 'url') || col(row, 'link') || col(row, 'grant url') || null,
    city: col(row, 'city') || null,
    state: col(row, 'state') || null,
    focusAreas: splitAreas(col(row, 'focus areas') || col(row, 'categories') || col(row, 'tags')),
    totalGiving: parseDollar(col(row, 'total giving')),
    assetAmount: parseDollar(col(row, 'total assets') || col(row, 'assets')),
    website: col(row, 'website') || null,
    contactName: col(row, 'contact') || col(row, 'contact name') || null,
    contactEmail: col(row, 'email') || col(row, 'contact email') || null,
    source: 'generic_csv',
    _raw: row,
  };
}

function mapGenericStatus(s: string): ImportedRecord['status'] {
  if (/awarded|won|funded|approved|grant.?received/i.test(s)) return 'awarded';
  if (/applied|submitted|pending|in.?progress|under.?review/i.test(s)) return 'applied';
  if (/declined|rejected|not.?funded|passed|denied|lost/i.test(s)) return 'passed';
  return 'researching';
}

// ── Utility helpers ─────────────────────────────────────────────────────────

/**
 * Case-insensitive, whitespace-tolerant column lookup.
 * Tries exact match first, then fuzzy "includes" for common variations.
 */
function col(row: Record<string, string>, key: string): string {
  const keyLower = key.toLowerCase().trim();
  // Exact match first
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase().trim() === keyLower) return (v ?? '').trim();
  }
  // Fuzzy includes match
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase().trim().includes(keyLower)) return (v ?? '').trim();
  }
  return '';
}

/** Clean an EIN string to just digits, with optional dash format (XX-XXXXXXX). */
function cleanEin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 9) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  if (digits.length >= 7) return digits; // partial but usable
  return null;
}

/** Parse a dollar string like "$1,234,567" or "1234567" into a number. */
function parseDollar(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : Math.round(n);
}

/** Parse various date formats into an ISO date string. */
function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try native Date parse first
  const d = new Date(trimmed);
  if (!isNaN(d.getTime()) && d.getFullYear() > 1970) {
    return d.toISOString().split('T')[0];
  }

  // Try MM/DD/YYYY or MM-DD-YYYY
  const mdy = trimmed.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (mdy) {
    const d2 = new Date(parseInt(mdy[3]), parseInt(mdy[1]) - 1, parseInt(mdy[2]));
    if (!isNaN(d2.getTime())) return d2.toISOString().split('T')[0];
  }

  return null;
}

/** Build a notes string from labelled values, skipping empties. */
function buildNotes(parts: { label: string; value: string | null | undefined }[]): string {
  return parts
    .filter(p => p.value && p.value.trim())
    .map(p => `${p.label}: ${p.value!.trim()}`)
    .join('\n');
}

/** Split comma/semicolon-separated focus areas into an array. */
function splitAreas(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,|]/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ── EIN-based matching ──────────────────────────────────────────────────────

/**
 * Given a list of EINs, look up matching funders in FunderMatch's database.
 * Returns a map from cleaned EIN → funder ID.
 */
export async function matchFundersByEin(
  eins: string[],
  supabaseClient: any,
): Promise<Map<string, { id: string; name: string }>> {
  const result = new Map<string, { id: string; name: string }>();
  if (eins.length === 0) return result;

  // Clean EINs to XX-XXXXXXX format for matching
  const cleanedEins = eins
    .map(e => cleanEin(e))
    .filter((e): e is string => e !== null);

  if (cleanedEins.length === 0) return result;

  // Batch lookup in chunks of 100
  for (let i = 0; i < cleanedEins.length; i += 100) {
    const chunk = cleanedEins.slice(i, i + 100);
    const { data } = await supabaseClient
      .from('funders')
      .select('id, name, foundation_ein')
      .in('foundation_ein', chunk);

    if (data) {
      for (const row of data) {
        if (row.foundation_ein) {
          result.set(row.foundation_ein, { id: row.id, name: row.name });
        }
      }
    }
  }

  return result;
}

/**
 * Given a list of funder names, look up approximate matches.
 * Falls back to name matching when EIN is not available.
 */
export async function matchFundersByName(
  names: string[],
  supabaseClient: any,
): Promise<Map<string, { id: string; name: string }>> {
  const result = new Map<string, { id: string; name: string }>();
  if (names.length === 0) return result;

  // Batch lookup in chunks of 50
  for (let i = 0; i < names.length; i += 50) {
    const chunk = names.slice(i, i + 50);
    // Use ilike for case-insensitive matching
    for (const name of chunk) {
      const { data } = await supabaseClient
        .from('funders')
        .select('id, name')
        .ilike('name', name)
        .limit(1);

      if (data && data.length > 0) {
        result.set(name.toLowerCase(), { id: data[0].id, name: data[0].name });
      }
    }
  }

  return result;
}
