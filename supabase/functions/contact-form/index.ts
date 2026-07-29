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
//    Uses `_shared/rate_limit.ts`, which as of FM-2026-07-29-04 is backed by
//    `public.check_rate_limit` in Postgres rather than a module-level Map. The
//    old Map-based version enforced nothing on this project, because each
//    request gets a fresh Deno isolate — see that migration for the measurement.
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
import { ipRateLimit } from "../_shared/rate_limit.ts";
import { corsHeaders as _sharedCorsHeaders } from "../_shared/cors.ts";

function corsHeaders(req: Request | null = null): Record<string, string> {
  return _sharedCorsHeaders(req?.headers.get("origin") ?? null, {
    methods: "POST, OPTIONS",
  });
}

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const TO_EMAIL = "support@fundermatch.org";

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

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
  const limited = await ipRateLimit(req, {
    namespace: "contact-form",
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    extraHeaders: CORS_HEADERS,
  });
  if (!limited.allow && limited.response) return limited.response;

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
