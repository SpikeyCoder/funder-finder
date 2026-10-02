/**
 * request-organization — Supabase Edge Function
 *
 * Trello #153 / FM-2026-10-02-02: when /search finds nothing, the visitor can
 * ask for the organization to be added. This queues the request in
 * public.organization_requests; process-organization-requests resolves it
 * against IRS data on a schedule (see migration 20261002140000).
 *
 * Public (verify_jwt=false) like contact-form, so the per-IP limit below is
 * the control that bounds abuse. 5/hour is ample for a person (one request
 * per missing organization) while keeping the table and the downstream
 * ProPublica lookups cheap. Fails open if the limiter itself errors, matching
 * the other public endpoints.
 *
 * The table is service-role only (RLS on, no policies); nothing is ever read
 * back to the caller beyond "queued".
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { ipRateLimit } from "../_shared/rate_limit.ts";
import { corsHeaders, preflightResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ValidRequest {
  query: string;
  ein: string | null;
  state: string | null;
  requester_email: string | null;
}

// Returns the cleaned request, or an error message for the caller.
export function validate(body: unknown): ValidRequest | string {
  if (!body || typeof body !== "object") return "Invalid request body";
  const b = body as Record<string, unknown>;

  // Strip control characters and collapse whitespace.
  const query = typeof b.name === "string"
    ? b.name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  if (query.length < 2 || query.length > 200) {
    return "Organization name must be 2–200 characters";
  }

  let ein: string | null = null;
  if (typeof b.ein === "string" && b.ein.trim()) {
    const digits = b.ein.replace(/[\s-]/g, "");
    if (!/^\d{9}$/.test(digits)) return "EIN must be 9 digits";
    ein = digits;
  }

  let state: string | null = null;
  if (typeof b.state === "string" && b.state.trim()) {
    const s = b.state.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(s)) return "State must be a 2-letter code";
    state = s;
  }

  let requester_email: string | null = null;
  if (typeof b.email === "string" && b.email.trim()) {
    const e = b.email.trim();
    if (e.length > 254 || !EMAIL_RE.test(e)) return "Invalid email address";
    requester_email = e;
  }

  return { query, ein, state, requester_email };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

if (import.meta.main) {
  Deno.serve(async (req: Request) => {
    const headers = corsHeaders(req.headers.get("origin"), { methods: "POST, OPTIONS" });

    if (req.method === "OPTIONS") return preflightResponse(req);
    if (req.method !== "POST") return json(405, { error: "Method not allowed" }, headers);

    const limited = await ipRateLimit(req, {
      namespace: "request-organization",
      limit: RATE_LIMIT,
      windowMs: RATE_WINDOW_MS,
      extraHeaders: headers,
    });
    if (!limited.allow && limited.response) return limited.response;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Invalid JSON" }, headers);
    }

    const valid = validate(body);
    if (typeof valid === "string") return json(400, { error: valid }, headers);

    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.error("request-organization: SUPABASE_URL / SERVICE_ROLE_KEY unset");
      return json(500, { error: "Internal server error" }, headers);
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/organization_requests`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(valid),
      });

      // 409 = the pending-dedupe unique index: this requester (same email, or
      // no email) already asked for this organization and it's still queued.
      // Same outcome for the caller.
      if (res.ok || res.status === 409) {
        return json(200, { ok: true, queued: true }, headers);
      }

      console.error("request-organization insert failed:", res.status, await res.text());
      return json(502, { error: "Could not save your request" }, headers);
    } catch (err) {
      console.error("request-organization error:", err);
      return json(500, { error: "Internal server error" }, headers);
    }
  });
}
