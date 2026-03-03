import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import {
  initGoatCounter,
  trackOutboundClick,
  trackPageView,
  trackSaveListAccess,
} from '../lib/analytics';

export default function AnalyticsTracker() {
  const location = useLocation();
  const lastTrackedPath = useRef<string>('');

  useEffect(() => {
    initGoatCounter();
  }, []);

  useEffect(() => {
    const currentPath = `${location.pathname}${location.search}${location.hash}`;
    if (lastTrackedPath.current === currentPath) return;

    lastTrackedPath.current = currentPath;
    trackPageView(currentPath, document.title);

    if (location.pathname === '/saved') {
      trackSaveListAccess();
    }
  }, [location.pathname, location.search, location.hash]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;

      let outboundUrl: URL;
      try {
        outboundUrl = new URL(href, window.location.href);
      } catch {
        return;
      }

      if (!/^https?:$/.test(outboundUrl.protocol)) return;
      if (outboundUrl.origin === window.location.origin) return;

      const label = anchor.textContent?.trim();
      trackOutboundClick(outboundUrl.href, label?.slice(0, 120));
    };

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  return null;
}
