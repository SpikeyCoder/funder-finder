// FM-IC-CFG-002: FunderMatch public API for workflow automation.
//
// A documented, API-key-authenticated, read-only surface over a user's grant
// pipeline so teams can pull FunderMatch data into other tools (Zapier, Make,
// custom scripts, BI). Closes the Instrumentl gap flagged PARTIAL in the
// 2026-06-14 usability audit ("No public OpenAPI yet").
//
// Auth model (NOT the in-app JWT flow): callers present a personal API key as
//   Authorization: Bearer fmk_live_xxxxxxxx...
// We hash it (SHA-256) and resolve an un-revoked api_keys row via the
// service-role client, then scope every read to that row's user_id.
//
// Routes (path suffix after /functions/v1/public-api):
//   GET /                 -> service descriptor + endpoint index (no auth)
//   GET /openapi.json     -> OpenAPI 3.0 document (no auth)
//   GET /v1/projects      -> caller's projects
//   GET /v1/pipeline-statuses
//   GET /v1/tracked-grants  (optional ?project_id= & ?status_slug= & ?limit=)
//   GET /v1/saved-funders   (optional ?limit=)

import { adminClient } from "../_shared/auth.ts";
import { corsHeaders as _corsHeaders } from "../_shared/cors.ts";
import { sanitiseError } from "../_shared/errors.ts";

// Public API is consumed by third-party tools, so wildcard CORS (no creds).
const CORS = { allowAny: true, methods: "GET, OPTIONS" } as const;
function headers(req: Request): Record<string, string> {
  return _corsHeaders(req.headers.get("origin"), CORS);
}
function jsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...headers(req), "Content-Type": "application/json" },
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

interface ResolvedKey {
  userId: string;
  keyId: string;
}

/** Resolve a presented bearer API key to its owner, or null if invalid. */
async function resolveApiKey(
  supabase: ReturnType<typeof adminClient>,
  req: Request,
): Promise<ResolvedKey | null> {
  const auth = req.headers.get("authorization") || "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
  if (!presented || !presented.startsWith("fmk_")) return null;
  const keyHash = await sha256Hex(presented);
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, user_id, revoked_at")
    .eq("key_hash", keyHash)
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !data) return null;
  // best-effort last_used bookkeeping; never blocks the response
  supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", (data as any).id)
    .then(() => {}, () => {});
  return { userId: (data as any).user_id, keyId: (data as any).id };
}

function clampLimit(raw: string | null, fallback = 100, max = 500): number {
  const n = parseInt(raw || "", 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

const BASE_PATH = "/functions/v1/public-api";

function openApiDoc(origin: string): unknown {
  const server = "https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/public-api";
  return {
    openapi: "3.0.3",
    info: {
      title: "FunderMatch Public API",
      version: "1.0.0",
      description:
        "Read-only access to your FunderMatch grant pipeline for workflow " +
        "automation. Authenticate with a personal API key (Account Settings " +
        "> API) sent as a Bearer token. All responses are scoped to the key " +
        "owner.",
      contact: { name: "FunderMatch", url: "https://fundermatch.org/contact" },
    },
    servers: [{ url: server }],
    security: [{ ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "fmk_live_*",
          description: "Personal API key issued in Account Settings > API.",
        },
      },
      schemas: {
        Project: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            description: { type: "string", nullable: true },
            created_at: { type: "string", format: "date-time" },
          },
        },
        PipelineStatus: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            slug: { type: "string" },
            color: { type: "string" },
            sort_order: { type: "integer" },
            is_terminal: { type: "boolean" },
          },
        },
        TrackedGrant: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            project_id: { type: "string", format: "uuid" },
            funder_name: { type: "string" },
            funder_ein: { type: "string", nullable: true },
            grant_title: { type: "string", nullable: true },
            amount: { type: "number", nullable: true },
            deadline: { type: "string", format: "date", nullable: true },
            status_id: { type: "string", format: "uuid" },
            awarded_amount: { type: "number", nullable: true },
            awarded_date: { type: "string", format: "date", nullable: true },
            custom_fields: { type: "object", additionalProperties: true },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        SavedFunder: {
          type: "object",
          properties: {
            funder_id: { type: "string" },
            status: { type: "string" },
            notes: { type: "string", nullable: true },
            custom_fields: { type: "object", additionalProperties: true },
            saved_at: { type: "string", format: "date-time" },
          },
        },
        Error: { type: "object", properties: { error: { type: "string" } } },
      },
    },
    paths: {
      "/v1/projects": {
        get: {
          summary: "List your projects",
          responses: {
            "200": {
              description: "Array of projects",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/Project" } },
                },
              },
            },
            "401": { description: "Missing or invalid API key" },
          },
        },
      },
      "/v1/pipeline-statuses": {
        get: {
          summary: "List your pipeline statuses",
          responses: {
            "200": {
              description: "Array of pipeline statuses",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/PipelineStatus" } },
                },
              },
            },
          },
        },
      },
      "/v1/tracked-grants": {
        get: {
          summary: "List your tracked grants (opportunities)",
          parameters: [
            { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
            { name: "status_slug", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          ],
          responses: {
            "200": {
              description: "Array of tracked grants",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/TrackedGrant" } },
                },
              },
            },
          },
        },
      },
      "/v1/saved-funders": {
        get: {
          summary: "List your saved funders",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          ],
          responses: {
            "200": {
              description: "Array of saved funders",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/SavedFunder" } },
                },
              },
            },
          },
        },
      },
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: headers(req) });
  if (req.method !== "GET") return errorResponse(req, "Method not allowed", 405);

  const url = new URL(req.url);
  // Normalise the route suffix after the function base path.
  let route = url.pathname;
  const idx = route.indexOf(BASE_PATH);
  if (idx >= 0) route = route.slice(idx + BASE_PATH.length);
  route = route.replace(/\/+$/, "") || "/";

  // --- Public (unauthenticated) endpoints ---
  if (route === "/openapi.json") {
    return jsonResponse(req, openApiDoc(url.origin));
  }
  if (route === "/") {
    return jsonResponse(req, {
      service: "FunderMatch Public API",
      version: "1.0.0",
      documentation: `${BASE_PATH}/openapi.json`,
      authentication: "Bearer API key (Account Settings > API)",
      endpoints: [
        "/v1/projects",
        "/v1/pipeline-statuses",
        "/v1/tracked-grants",
        "/v1/saved-funders",
      ],
    });
  }

  // --- Authenticated endpoints ---
  try {
    const supabase = adminClient();
    const resolved = await resolveApiKey(supabase, req);
    if (!resolved) {
      return errorResponse(
        req,
        "Missing or invalid API key. Send 'Authorization: Bearer fmk_live_...'.",
        401,
      );
    }
    const { userId } = resolved;

    if (route === "/v1/projects") {
      const { data, error } = await supabase
        .from("projects")
        .select("id, name, description, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) return errorResponse(req, sanitiseError(error), 500);
      return jsonResponse(req, data || []);
    }

    if (route === "/v1/pipeline-statuses") {
      const { data, error } = await supabase
        .from("pipeline_statuses")
        .select("id, name, slug, color, sort_order, is_terminal")
        .eq("user_id", userId)
        .order("sort_order", { ascending: true });
      if (error) return errorResponse(req, sanitiseError(error), 500);
      return jsonResponse(req, data || []);
    }

    if (route === "/v1/tracked-grants") {
      let q = supabase
        .from("tracked_grants")
        .select(
          "id, project_id, funder_name, funder_ein, grant_title, amount, deadline, status_id, awarded_amount, awarded_date, custom_fields, updated_at",
        )
        .eq("user_id", userId);
      const projectId = url.searchParams.get("project_id");
      if (projectId) q = q.eq("project_id", projectId);
      const statusSlug = url.searchParams.get("status_slug");
      if (statusSlug) {
        const { data: st } = await supabase
          .from("pipeline_statuses")
          .select("id")
          .eq("user_id", userId)
          .eq("slug", statusSlug)
          .maybeSingle();
        if (st) q = q.eq("status_id", (st as any).id);
        else return jsonResponse(req, []);
      }
      q = q.order("updated_at", { ascending: false }).limit(clampLimit(url.searchParams.get("limit")));
      const { data, error } = await q;
      if (error) return errorResponse(req, sanitiseError(error), 500);
      return jsonResponse(req, data || []);
    }

    if (route === "/v1/saved-funders") {
      const { data, error } = await supabase
        .from("saved_funders")
        .select("funder_id, status, notes, custom_fields, saved_at")
        .eq("user_id", userId)
        .order("saved_at", { ascending: false })
        .limit(clampLimit(url.searchParams.get("limit")));
      if (error) return errorResponse(req, sanitiseError(error), 500);
      return jsonResponse(req, data || []);
    }

    return errorResponse(req, `Unknown endpoint: ${route}`, 404);
  } catch (err: any) {
    return errorResponse(req, sanitiseError(err), 500);
  }
});
