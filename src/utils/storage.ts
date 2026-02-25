import { Funder } from '../types';

const SAVED_KEY = 'savedFunders_v2'; // v2 stores full objects

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
