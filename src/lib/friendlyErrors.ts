/**
 * friendlyErrors — convert technical/raw API errors into customer-facing
 * messages.
 *
 * Added to address bug reports that error banners exposed code (HTTP
 * status numbers, Postgres error strings, raw fetch errors) instead of
 * something a non-technical user can act on.
 */

const HTTP_MESSAGES: Record<number, string> = {
  400: 'Some required information is missing or invalid. Please review the form and try again.',
  401: 'Your session has expired. Please sign in again to continue.',
  403: 'You do not have permission to do that. If you believe this is wrong, contact your team admin.',
  404: 'We could not find what you were looking for.',
  408: 'The request took too long. Please check your connection and try again.',
  409: 'This conflicts with something that already exists. Please review and try again.',
  413: 'The file you tried to upload is too large.',
  422: 'Some required information is missing or invalid. Please review the form and try again.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'Something went wrong on our end. Please try again in a moment.',
  502: 'We are having trouble reaching the server. Please try again shortly.',
  503: 'The service is temporarily unavailable. Please try again shortly.',
  504: 'The request timed out. Please try again.',
};

const PHRASE_MAP: Array<[RegExp, string]> = [
  [/failed to fetch/i, 'We could not reach the server. Please check your internet connection and try again.'],
  [/network ?error/i, 'We could not reach the server. Please check your internet connection and try again.'],
  [/networkerror/i, 'We could not reach the server. Please check your internet connection and try again.'],
  [/JWT ?expired|invalid token|invalid signature|jwt ?verification/i, 'Your session has expired. Please sign in again to continue.'],
  [/missing authorization|missing.*auth.*header|no auth/i, 'Your session has expired. Please sign in again to continue.'],
  [/unauthorized/i, 'Your session has expired. Please sign in again to continue.'],
  [/duplicate key|already exists|unique violation/i, 'That already exists. Try a different value.'],
  [/violates not-null|null value in column/i, 'Some required information is missing. Please review the form and try again.'],
  [/foreign key|not present in table/i, 'The selected item is no longer available. Please refresh and try again.'],
  [/permission denied|insufficient_privilege/i, 'You do not have permission to do that.'],
  [/timeout|timed ?out/i, 'The request took too long. Please try again.'],
  [/rate limit|too many requests/i, 'Too many requests. Please wait a moment and try again.'],
  [/storage.*quota|file too large|payload too large/i, 'The file you tried to upload is too large.'],
];

export function friendlyError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (err == null) return fallback;

  // string or Error -> raw text
  let raw = '';
  if (typeof err === 'string') {
    raw = err;
  } else if (err instanceof Error) {
    raw = err.message || '';
  } else if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    raw = (typeof e.message === 'string' && e.message) || (typeof e.error === 'string' && e.error) || '';
  }

  if (!raw) return fallback;

  // Strip "(HTTP 500)" / "(500)" suffixes for matching
  const httpMatch = raw.match(/\b(HTTP\s*)?(\d{3})\b/);
  if (httpMatch) {
    const code = parseInt(httpMatch[2], 10);
    if (HTTP_MESSAGES[code]) return HTTP_MESSAGES[code];
  }

  for (const [re, msg] of PHRASE_MAP) {
    if (re.test(raw)) return msg;
  }

  // If the message looks like a Postgres / function error code (uppercase
  // SNAKE_CASE or starts with "pg_"), don't expose it to users.
  if (/^([A-Z]{2,}_?){2,}$/.test(raw) || raw.startsWith('pg_')) {
    return fallback;
  }

  // If reasonably short and human-readable, show it as-is
  if (raw.length <= 200 && !/[<>{};]/.test(raw)) return raw;

  return fallback;
}
