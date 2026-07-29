// Source recovered 2026-07-29 (FM-2026-07-29-02) — this function was live in
// production with no source in this repo. See the recovery commit for provenance.
//
// FM-2026-07-29-03: hardened the two issues that recovery surfaced.
//
// 1. WILDCARD CORS -> shared allowlist. It carried its own inline
//    `Access-Control-Allow-Origin: "*"`, exactly the per-function pattern
//    `_shared/cors.ts` was written to replace, so it was the last wildcard POST
//    endpoint in the fleet and gained nothing from the 2026-07-29 CORS rollout.
//    Now delegates to the shared helper, matching what report-bug did in
//    FM-2026-05-31-01. Callers from fundermatch.org / www.fundermatch.org are
//    unaffected (src/pages/ContactPage.tsx posts from the apex).
//
// 2. NO RATE LIMITING -> durable per-IP limit. The previous comment
//    "Rate limit: basic check on message length" was not a rate limit; it capped
//    the body at 5000 chars. This endpoint is unauthenticated (verify_jwt=false)
//    and sends mail via Resend, so it was an open spam relay bounded only by
//    payload size.
//
//    It does NOT use `_shared/rate_limit.ts`. That helper counts in a
//    module-level Map, which requires the Deno isolate to be reused between
//    requests — and on this project it is not. Measured 2026-07-29: eight rapid
//    requests each got a different module-scope boot id and a hit count of 1, so
//    a deliberately-low limit of 3 never tripped. See FM-2026-07-29-04 /
//    migration 20260729040000 for the evidence and the replacement.
//
//    Instead this calls `public.check_rate_limit`, which keeps the counter in
//    Postgres — the one store every isolate shares — and decides atomically in a
//    single INSERT .. ON CONFLICT so concurrent isolates cannot race past it.
//
//    Threshold: 10 requests per IP per hour. Deliberately looser than one-per-
//    person because small nonprofits often share one NAT'd office IP, and a
//    false 429 on a contact form is a lost enquiry.
//
//    Fails OPEN if the limiter itself errors: a database blip should not take
//    down the contact form. The failure is logged rather than swallowed.
//
// Note CORS only constrains browsers — it does nothing about a direct POST from
// curl. The rate limiter is the control that actually bounds abuse here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders as _sharedCorsHeaders } from "../_shared/cors.ts";

function corsHeaders(req: Request | null = null): Record<string, string> {
  return _sharedCorsHeaders(req?.headers.get("origin") ?? null, {
    methods: "POST, OPTIONS",
  });
}

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const TO_EMAIL = "support@fundermatch.org";

const RATE_LIMIT = 10;
const RATE_WINDOW_SECONDS = 60 * 60;

/**
 * Caller IP. Cloudflare sets `cf-connecting-ip` to the single true client
 * address; `x-forwarded-for` is a comma-separated chain (and on this project
 * repeats the client), so the leftmost entry is the fallback.
 */
function callerIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || null;
}

/** Durable, cross-isolate rate limit. Fails open on any error. */
async function underRateLimit(req: Request): Promise<boolean> {
  const ip = callerIp(req);
  if (!ip) return true; // unidentifiable caller: fail open, as before

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return true;

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/check_rate_limit`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_key: `contact-form:${ip}`,
        p_limit: RATE_LIMIT,
        p_window_seconds: RATE_WINDOW_SECONDS,
      }),
    });
    if (!res.ok) {
      console.error("check_rate_limit failed:", res.status, await res.text());
      return true;
    }
    return (await res.json()) !== false;
  } catch (err) {
    console.error("check_rate_limit threw:", err);
    return true;
  }
}

Deno.serve(async (req: Request) => {
  const CORS_HEADERS = corsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Before any parsing or outbound mail: bound abuse per caller IP.
  if (!(await underRateLimit(req))) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Please try again later." }),
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json",
          "Retry-After": String(RATE_WINDOW_SECONDS),
        },
      },
    );
  }

  try {
    const { name, email, message } = await req.json();

    if (!name || !email || !message) {
      return new Response(JSON.stringify({ error: "All fields are required" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: "Invalid email format" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (message.length > 5000) {
      return new Response(JSON.stringify({ error: "Message too long" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (RESEND_API_KEY) {
      // Send via Resend API
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "FunderMatch Contact <noreply@fundermatch.org>",
          to: [TO_EMAIL],
          reply_to: email,
          subject: `[FunderMatch Contact] Message from ${name}`,
          text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
          html: `<p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><hr/><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        console.error("Resend error:", res.status, body);
        return new Response(JSON.stringify({ error: "Failed to send email" }), {
          status: 502,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    } else {
      // Fallback: store in Supabase table
      const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

      if (supabaseUrl && serviceKey) {
        const res = await fetch(`${supabaseUrl}/rest/v1/contact_messages`, {
          method: "POST",
          headers: {
            "apikey": serviceKey,
            "Authorization": `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ name, email, message }),
        });

        if (!res.ok) {
          console.error("Supabase insert error:", res.status, await res.text());
          // Still return success to user - we'll check logs
        }
      } else {
        console.log("Contact form submission (no email provider configured):", { name, email, message: message.substring(0, 100) });
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Contact form error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
