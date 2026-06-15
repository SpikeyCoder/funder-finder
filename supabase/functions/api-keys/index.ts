// FM-IC-CFG-002: in-app API key manager.
// JWT-authenticated CRUD over the caller's personal API keys. The raw secret
// is returned exactly once (on creation); only a SHA-256 hash + short display
// prefix are persisted. The keys authenticate requests to the `public-api`
// edge function.
//
// Auth: see _shared/auth.ts -- decodes + HMAC-verifies the caller JWT and
// queries via a service-role client filtered by user_id.

import { authFromRequest, adminClient, statusForAuthError } from "../_shared/auth.ts";
import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";
import { sanitiseError } from "../_shared/errors.ts";

const CORS_HEADERS_OPTS = { methods: "GET, POST, DELETE, OPTIONS" } as const;
function CORS_HEADERS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_HEADERS_OPTS);
}

function jsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS(req), "Content-Type": "application/json" },
  });
}

function errorResponse(req: Request, message: string, status = 400) {
  return jsonResponse(req, { error: message }, status);
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomSecret(): string {
  // 32 bytes of CSPRNG randomness -> 64 hex chars.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Columns safe to expose to the in-app manager (never key_hash).
const PUBLIC_COLUMNS = "id, name, key_prefix, scopes, last_used_at, created_at, revoked_at";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS(req) });
  try {
    const { userId } = await authFromRequest(req);
    const supabase = adminClient();
    const url = new URL(req.url);

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("api_keys")
        .select(PUBLIC_COLUMNS)
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) return errorResponse(req, sanitiseError(error), 500);
      return jsonResponse(req, data || []);
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const name = (body?.name ?? "").toString().trim() || "API key";

      const secret = `fmk_live_${randomSecret()}`;
      const keyHash = await sha256Hex(secret);
      const keyPrefix = secret.slice(0, "fmk_live_".length + 8); // fmk_live_ + 8 hex

      const { data, error } = await supabase
        .from("api_keys")
        .insert({
          user_id: userId,
          name,
          key_prefix: keyPrefix,
          key_hash: keyHash,
          scopes: ["read"],
        })
        .select(PUBLIC_COLUMNS)
        .single();
      if (error) return errorResponse(req, sanitiseError(error), 500);

      // Return the raw secret exactly once — it is never retrievable again.
      return jsonResponse(req, { ...data, secret }, 201);
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return errorResponse(req, "Key id required");
      // Soft-revoke so historical last_used data is retained.
      const { error } = await supabase
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", userId);
      if (error) return errorResponse(req, sanitiseError(error), 500);
      return jsonResponse(req, { success: true });
    }

    return errorResponse(req, "Method not allowed", 405);
  } catch (err: any) {
    const message = err?.message || "Internal server error";
    return errorResponse(req, message, statusForAuthError(message));
  }
});
