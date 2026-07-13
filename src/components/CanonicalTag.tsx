import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const ORIGIN = 'https://fundermatch.org';

/**
 * Keeps <link rel="canonical"> in sync with the current route.
 *
 * The SPA shell (index.html) ships a self-referential homepage canonical, and
 * the prerender plugin bakes a per-route static canonical into each prerendered
 * subpage. This hook keeps that <link rel="canonical"> correct as the SPA
 * navigates on the client: it UPDATES the existing tag in place (querying for
 * one before creating a node), so the page is never left with two canonicals.
 * Non-prerendered fallback routes carry no static per-route canonical of their
 * own — a blanket static one would declare every deep route a duplicate of the
 * homepage (GSC "Alternate page with proper canonical tag") — so they rely on
 * this runtime update. Query strings and hashes are dropped so filter/search
 * parameter variants consolidate onto the clean URL.
 */
export default function CanonicalTag() {
  const { pathname } = useLocation();

  useEffect(() => {
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = pathname === '/' ? `${ORIGIN}/` : `${ORIGIN}${pathname}`;
  }, [pathname]);

  return null;
}
