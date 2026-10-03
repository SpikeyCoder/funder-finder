// Privacy scrubbing for crash and page-speed reports (FM-2026-10-03-02).
//
// One copy, used by both the browser (src/lib/monitoring.ts, which imports
// this file) and the monitor-report Edge Function (which redoes it, since
// reports are untrusted). Plain TypeScript with no Deno or DOM APIs, so it
// runs in both.

// Local part can't span URL syntax, so "…?email=eq.a@b.org" masks just the
// address; '%' is allowed in it so percent-encoded '+' and '.' are covered.
// Bounded (RFC 5321's 64 and 253) so a long string with no address can't
// make it backtrack quadratically.
const EMAIL = /[^\s@<>"'()/:?=&#]{1,64}(?:@|%40)[^\s@<>"'()/?=&#%]{1,253}\.[a-z]{2,24}/gi;

/**
 * Mask email addresses (plain or percent-encoded) and share-link tokens,
 * and drop query strings: from absolute URLs (with fragments), and from
 * anything else followed by `?key=`, such as a relative URL.
 */
export function scrub(text: string): string {
  // Query strings first: they're where addresses most often hide in URLs.
  return text
    .replace(/(https?:\/\/[^\s?#)"']*)[?#][^\s)"']*/gi, "$1")
    .replace(/\?(?=[\w.%-]+=)[^\s)"']*/g, "")
    // A share link's token is a secret, wherever the link appears.
    .replace(/\/shared\/[^\s/?#)"'`]+/gi, "/shared/:id")
    .replace(EMAIL, "[email]");
}

// The app's routes (src/App.tsx; tests/monitoring.test.mjs checks they match).
// ':id' marks a parameter. /shared/:id is a share link whose id is a secret
// token: it must never be stored or shown.
export const ROUTES = [
  "/", "/applications", "/browse", "/contact", "/dashboard", "/funder/:id", "/grant-writer", "/import",
  "/login", "/mission", "/onboarding/first-project", "/onboarding/matches", "/onboarding/profile",
  "/onboarding/save", "/onboarding/welcome", "/portfolio", "/privacy", "/projects/:id",
  "/projects/:id/calendar", "/projects/:id/matches", "/projects/:id/peers", "/projects/:id/settings",
  "/projects/:id/tracker", "/projects/new", "/projects/new/chat", "/recipient/:id", "/reports", "/results",
  "/saved", "/search", "/settings", "/settings/team", "/settings/team/activity", "/shared/:id", "/signup",
  "/tasks", "/terms",
];

const ROUTE_PATTERNS = ROUTES.map((r) => ({
  route: r,
  re: new RegExp("^" + r.replace(/:id/g, "[^/]+") + "$", "i"),
}));

/**
 * The route a path belongs to, with ids and tokens as `:id`
 * (/shared/<token> → /shared/:id, /projects/42/tracker →
 * /projects/:id/tracker), or "(other)" for a path the app has no route for.
 * Literal routes win over parameter ones (/projects/new is not /projects/:id).
 */
export function normalizePath(pathname: string): string {
  // React Router matches case-insensitively, so /Search is /search.
  const bare = pathname.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase() || "/";
  const literal = ROUTES.find((r) => !r.includes(":") && r === bare);
  if (literal) return literal;
  return ROUTE_PATTERNS.find((p) => p.re.test(bare))?.route ?? "(other)";
}
