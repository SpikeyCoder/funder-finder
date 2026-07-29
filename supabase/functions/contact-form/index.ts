// RECOVERED 2026-07-29 (FM-2026-07-29-02) from the deployed Edge Function.
// This function was live in production (v6, deployed 2026-05-02) with NO source
// in this repo. Body below is the deployed source verbatim; only this header was
// added. See the recovery commit for the audit notes on wildcard CORS and the
// absence of real rate limiting — both are PRE-EXISTING and deliberately left
// unchanged here so that recovery is a faithful snapshot, not a behaviour change.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const TO_EMAIL = "support@fundermatch.org";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
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

    // Rate limit: basic check on message length
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
