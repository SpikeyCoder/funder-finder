// Authentication for Edge Functions called by pg_cron (through pg_net), which
// sends CRON_SECRET from Vault. Same scheme as send-reminders and
// process-organization-requests: `X-Cron-Secret: <secret>` or
// `Authorization: Bearer cron:<secret>`. Fails closed when CRON_SECRET is unset.

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function cronAuthorized(req: Request, expected: string): boolean {
  if (!expected) return false; // fail closed
  const header = req.headers.get("x-cron-secret") || "";
  if (header && constantTimeEqual(header, expected)) return true;
  const auth = req.headers.get("authorization") || "";
  return auth.startsWith("Bearer cron:") && constantTimeEqual(auth.slice("Bearer cron:".length).trim(), expected);
}
