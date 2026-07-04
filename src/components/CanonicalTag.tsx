import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const ORIGIN = 'https://fundermatch.org';

/**
 * Keeps <link rel="canonical"> in sync with the current route.
 *
 * The SPA shell (index.html) ships without a canonical tag: a static one
 * would declare every route a duplicate of the homepage, which excluded
 * all deep routes from Google's index (GSC "Alternate page with proper
 * canonical tag"). Query strings and hashes are dropped so filter/search
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
