const SAVED_KEY = 'savedFunders';

export function getSavedIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveFunder(id: string): void {
  const ids = getSavedIds();
  if (!ids.includes(id)) {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...ids, id]));
  }
}

export function unsaveFunder(id: string): void {
  const ids = getSavedIds();
  localStorage.setItem(SAVED_KEY, JSON.stringify(ids.filter(i => i !== id)));
}

export function issaved(id: string): boolean {
  return getSavedIds().includes(id);
}
