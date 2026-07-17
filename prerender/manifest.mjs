/**
 * Prerender manifest — the single source of truth for which public routes get
 * static prerendered HTML, and the SEO metadata each one ships.
 *
 * Two collaborators consume this file:
 *   1. scripts/prerender.mjs         — renders each route in a headless browser
 *                                       and writes the body fragment to
 *                                       prerender/bodies/<slug>.html
 *   2. scripts/vite-plugin-prerender — at `vite build` time, assembles each
 *                                       dist/<dir>/index.html from the freshly
 *                                       built shell + this metadata + the body
 *                                       fragment (no browser needed at build).
 *
 * Why this list: these are the PUBLIC routes that currently serve only the empty
 * SPA shell to non-JS crawlers (Perplexity, ChatGPT, Googlebot's no-JS pass).
 * Auth-gated, per-user, and dynamic :id routes are deliberately excluded — see
 * EXCLUDED_ROUTES at the bottom for the rationale.
 */

const ORIGIN = 'https://fundermatch.org';

/** WebSite node reused as `isPartOf` so each WebPage is tied to the site graph. */
const WEBSITE = {
  '@type': 'WebSite',
  name: 'FunderMatch',
  url: `${ORIGIN}/`,
};

/** Build a schema.org WebPage (or subtype) JSON-LD object for a route. */
function webPage(type, path, name, description) {
  return {
    '@context': 'https://schema.org',
    '@type': type,
    name,
    description,
    url: `${ORIGIN}${path}`,
    isPartOf: WEBSITE,
    publisher: {
      '@type': 'Organization',
      name: 'FunderMatch',
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/favicon-512.png`,
    },
  };
}

/**
 * @typedef {Object} PrerenderRoute
 * @property {string}  route   Client route path (what react-router matches).
 * @property {string}  dir     Output directory under dist ('' = root index.html).
 * @property {string}  slug    Body-fragment filename stem (prerender/bodies/<slug>.html).
 * @property {boolean} [headManaged] When false, leave the shell <head> untouched
 *                                   (used for '/', whose head index.html already owns).
 * @property {string}  [title]
 * @property {string}  [description]
 * @property {object}  [jsonld] schema.org object injected as application/ld+json.
 */

/** @type {PrerenderRoute[]} */
export const ROUTES = [
  {
    // Homepage: index.html already ships a curated <head> (WebApplication +
    // Organization + FAQPage). We only inject rendered body content so no-JS
    // crawlers see the hero, feature copy, and stats instead of an empty <div>.
    route: '/',
    dir: '',
    slug: 'home',
    headManaged: false,
  },
  {
    route: '/mission',
    dir: 'mission',
    slug: 'mission',
    title: 'Find Funders for Your Nonprofit | FunderMatch',
    description:
      'Describe your nonprofit’s mission and get an instant AI-ranked list of foundations, DAFs, and corporate giving aligned to your work. Free, no account.',
    jsonld: webPage(
      'WebPage',
      '/mission',
      'Find Funders for Your Nonprofit',
      'Describe your nonprofit’s mission and get an instant AI-ranked list of aligned foundations, donor-advised funds, and corporate giving programs.',
    ),
  },
  {
    route: '/search',
    dir: 'search',
    slug: 'search',
    title: 'Search Nonprofit Funders and Grant Recipients | FunderMatch',
    description:
      'Search 460,000+ funders and 449,000+ grant recipients by name or EIN. Explore IRS 990 giving data, funding trends, and grant history for free.',
    jsonld: webPage(
      'CollectionPage',
      '/search',
      'Search Organizations',
      'Search 460,000+ funders and 449,000+ grant recipients by name or EIN and explore their 990 giving data.',
    ),
  },
  {
    route: '/privacy',
    dir: 'privacy',
    slug: 'privacy',
    title: 'Privacy Policy | FunderMatch',
    description:
      'How FunderMatch collects, uses, and protects your information. We do not sell your data or use third-party advertising trackers.',
    jsonld: webPage(
      'WebPage',
      '/privacy',
      'Privacy Policy',
      'How FunderMatch collects, uses, and protects your information.',
    ),
  },
  {
    route: '/terms',
    dir: 'terms',
    slug: 'terms',
    title: 'Terms of Service | FunderMatch',
    description:
      'The terms governing your use of FunderMatch, a free tool that helps nonprofits discover funders and foundations from public IRS Form 990 data.',
    jsonld: webPage(
      'WebPage',
      '/terms',
      'Terms of Service',
      'The terms governing your use of the FunderMatch service.',
    ),
  },
  {
    route: '/contact',
    dir: 'contact',
    slug: 'contact',
    title: 'Contact FunderMatch',
    description:
      'Get in touch with the FunderMatch team. Questions, feedback, and partnership inquiries welcome.',
    jsonld: webPage(
      'ContactPage',
      '/contact',
      'Contact Us',
      'Get in touch with the FunderMatch team.',
    ),
  },
];

export const ORIGIN_URL = ORIGIN;

/**
 * Routes intentionally NOT prerendered, with the reason. Surfaced here (and in
 * the PR description) so the exclusion is a documented decision, not an oversight.
 */
export const EXCLUDED_ROUTES = {
  '/login, /signup':
    'Auth utility pages with thin, non-keyword content (sign-in buttons and a form) and no presence in the sitemap. Below the "meaningful body copy" bar; low SEO value. They still function normally via the SPA fallback.',
  '/browse':
    'Data-driven listing: fetches funder results from an edge function on mount. Its crawlable value IS the live data, which should not be baked into a static file; rendered without a backend it shows an empty/error state. Belongs with the data-aware prerender candidates (/funder/:id) as a follow-up.',
  '/grant-writer':
    'Redirects to /saved unless a funder is passed via navigation state (GrantWriter.tsx). Not a standalone landing page; would prerender to an empty/redirecting state.',
  '/saved':
    'Renders the signed-in user’s saved funders. Per-user content with no stable public value.',
  '/funder/:id':
    'Dynamic per-entity route; requires an id and live data. Candidate for a separate data-driven prerender pass, out of scope here.',
  '/recipient/:id': 'Dynamic per-entity route; same rationale as /funder/:id.',
  '/shared/:token': 'Unguessable per-share token; not publicly enumerable.',
  '/dashboard, /portfolio, /tasks, /reports, /applications, /import, /settings/*, /projects/*, /onboarding/*':
    'Auth-gated (behind AuthGuard). Redirect to /login for anonymous visitors, so there is no public content to index.',
};
