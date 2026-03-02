/**
 * storage.ts
 *
 * Two-layer save strategy:
 *
 *   Logged-in users  → Supabase `saved_funders` table (cross-device, persistent)
 *   Anonymous users  → localStorage (single-browser, no account needed)
 *
 * The DB layer is managed via AuthContext (saveFunderToDB / unsaveFunderFromDB /
 * fetchSavedFunders / fetchSavedIds). This file handles the localStorage
 * fallback so that components can read saved state synchronously for anonymous
 * users, and is also the canonical place to call from components that want to
 * save without caring about auth state (they pass the user down from useAuth).
 */

import { Funder, FunderStatus, SavedFunderEntry } from '../types';

const SAVED_KEY = 'savedFunders_v2'; // v2 stores full objects

// ── localStorage helpers (anonymous / fallback) ───────────────────────────────

export function getSavedFunders(): Funder[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
  } catch {
    return [];
  }
}

export function getSavedIds(): string[] {
  return getSavedFunders().map(f => f.id);
}

export function saveFunder(funder: Funder): void {
  const saved = getSavedFunders();
  if (!saved.find(f => f.id === funder.id)) {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...saved, funder]));
  }
}

export function unsaveFunder(id: string): void {
  const saved = getSavedFunders();
  localStorage.setItem(SAVED_KEY, JSON.stringify(saved.filter(f => f.id !== id)));
}

export function isSaved(id: string): boolean {
  return getSavedIds().includes(id);
}

/** Clear all locally saved funders (e.g. after sign-out). */
export function clearLocalSaved(): void {
  localStorage.removeItem(SAVED_KEY);
}

// ── Status & notes helpers (anonymous / fallback) ─────────────────────────────

const META_KEY = 'ff_funder_meta_v1';

type FunderMeta = { status: FunderStatus; notes: string };

function getAllMeta(): Record<string, FunderMeta> {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || '{}');
  } catch {
    return {};
  }
}

export function getFunderMeta(id: string): FunderMeta {
  return getAllMeta()[id] ?? { status: 'researching', notes: '' };
}

export function setFunderMeta(id: string, updates: Partial<FunderMeta>): void {
  try {
    const meta = getAllMeta();
    meta[id] = { ...getFunderMeta(id), ...updates };
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch { /* ignore */ }
}

/** Returns saved funders with status/notes for anonymous users. */
export function getSavedEntries(): SavedFunderEntry[] {
  return getSavedFunders().map(funder => ({
    funder,
    ...getFunderMeta(funder.id),
    savedAt: new Date().toISOString(),
  }));
}
