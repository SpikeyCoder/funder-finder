// Array.prototype.at for engines without it (Chrome < 92, Safari < 15.4,
// Firefox < 90). web-vitals' INP and CLS trackers call it in their
// PerformanceObserver callbacks, so there every layout shift threw "this.o.at
// is not a function" (Trello XzwkYl7L), and those visitors, often on older,
// slower devices, sent no INP or CLS. Patched rather than skipped so their
// vitals still count towards each page's p75.
export function installArrayAt(): void {
  if (typeof (Array.prototype as { at?: unknown }).at === 'function') return;
  Object.defineProperty(Array.prototype, 'at', {
    value: function at<T>(this: ArrayLike<T>, index: number): T | undefined {
      const len = this.length >>> 0;
      let i = Math.trunc(Number(index)) || 0;
      if (i < 0) i += len;
      return i < 0 || i >= len ? undefined : this[i];
    },
    writable: true,
    configurable: true,
  });
}
