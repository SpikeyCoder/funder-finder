// Array.prototype.at for engines without it (Chrome < 92, Safari < 15.4,
// Firefox < 90). web-vitals' CLS tracker calls it in its PerformanceObserver
// callback, so in Chrome 85-91 (older ones can't parse the bundle) every
// layout shift threw "this.o.at is not a function" (Trello XzwkYl7L), and
// those visitors, often on older, slower devices, sent no CLS. (Its INP
// tracker calls it too, but INP needs interactionId, Chrome 96+, which
// always has .at.) Patched rather than skipped so their CLS still counts
// towards each page's p75.
export function installArrayAt(): void {
  if (typeof (Array.prototype as { at?: unknown }).at === 'function') return;
  Object.defineProperty(Array.prototype, 'at', {
    value: function at<T>(this: ArrayLike<T>, index: number): T | undefined {
      const len = this.length >>> 0;
      // Unary + is ToNumber: it throws on a BigInt, as the native at() does.
      let i = Math.trunc(+index) || 0;
      if (i < 0) i += len;
      return i < 0 || i >= len ? undefined : this[i];
    },
    writable: true,
    configurable: true,
  });
}

// Installed on import, so importing this module first (main.tsx)
// patches .at before any later import's module body runs.
installArrayAt();
