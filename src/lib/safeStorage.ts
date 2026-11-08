// sessionStorage that never throws. Browsers can deny access to the property
// itself (SecurityError: "Access is denied for this document") in sandboxed
// iframes, with blocked site data, etc. (Trello prnL3oCE). Falls back to an
// in-memory map so the current page view still works.
const memory = new Map<string, string>();

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export const safeSession = {
  getItem(key: string): string | null {
    try {
      const s = store();
      const v = s ? s.getItem(key) : null;
      if (v !== null) return v;
    } catch { /* fall through to memory */ }
    return memory.has(key) ? memory.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    try {
      const s = store();
      if (s) { s.setItem(key, value); return; }
    } catch { /* fall through to memory */ }
    memory.set(key, value);
  },
  removeItem(key: string): void {
    memory.delete(key);
    try { store()?.removeItem(key); } catch { /* ignore */ }
  },
};
