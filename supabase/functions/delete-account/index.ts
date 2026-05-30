// Account self-deletion Edge Function.
//
// Deleting an auth user requires the service-role key, which must never ship
// to the browser — so the SPA calls this function, which authenticates the
// caller from their JWT (see _shared/auth.ts) and deletes ONLY their own
// account via the admin API. Removing the auth.users row cascade-deletes the
// user's owned rows (profile, projects, tracked grants, tasks, saved funders,
// notifications, etc.); a companion migration switches the remaining "actor"
// FKs (e.g. tasks.assignee_user_id, grant_status_history.changed_by) to
// SET NULL / CASCADE so the delete can't be blocked by a stray reference.

import { authFromRequest, adminClient, statusForAuthError } from "../_shared/auth.ts";
import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";
import { sanitiseError } from "../_shared/errors.ts";
import { ipRateLimit } from "../_shared/rate_limit.ts";

const CORS_HEADERS_OPTS = { methods: "POST, OPTIONS" } as const;
function CORS_HEADERS(req: Request | null = null): Record<string, string> {
  return _corsHeaders(req?.headers.get("origin") ?? null, CORS_HEADERS_OPTS);
}

function jsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS(req), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS(req) });

  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed" }, 405);
  }

  // Modest per-IP limit: deletion is destructive and self-scoped, but cap it
  // anyway to blunt brute-forcing of the endpoint.
  const limited = await ipRateLimit(req, {
    namespace: "delete-account",
    limit: 5,
    windowMs: 60_000,
    extraHeaders: CORS_HEADERS(req),
  });
  if (!limited.allow && limited.response) return limited.response;

  try {
    const { userId } = await authFromRequest(req);
    const supabase = adminClient();

    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) {
      // Log full detail server-side; return a generic message to the client.
      return jsonResponse(req, { error: sanitiseError(error, "Failed to delete account") }, 500);
    }

    return jsonResponse(req, { ok: true });
  } catch (err: any) {
    const msg = err?.message || "Internal server error";
    const status = statusForAuthError(msg);
    // Auth errors carry no schema info and are safe to surface; sanitise the rest.
    return jsonResponse(req, { error: status === 401 ? msg : sanitiseError(err) }, status);
  }
});
