/**
 * grant-writer — Supabase Edge Function
 *
 * Generates a complete, funder-specific grant application draft using Claude.
 *
 * Features:
 *   1. Past grant upload + style matching (optional)
 *   2. Deep web research for data-backed narratives
 *   3. Streaming SSE output
 *
 * Receives: { funder, mission, orgDetails, uploadedFilePaths?, sessionId? }
 * Returns:  Server-Sent Events stream with { text } chunks
 *
 * MIGRATED TO LOCAL JWT AUTH: Uses auth.ts (local JWT decode + service-role client)
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { extractText } from './text-extract.ts';
import { analyzeStyle, type StyleGuide } from './style-analysis.ts';
import { performResearch, type ResearchData } from './research.ts';
import { buildPrompt } from './prompt-builder.ts';
import { authFromRequest, adminClient } from "../_shared/auth.ts";
import { ipRateLimit } from "../_shared/rate_limit.ts";

// ── Config ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const TAVILY_API_KEY = Deno.env.get('TAVILY_API_KEY') || '';

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'http://localhost:5173',
]);

function corsHeaders(requestOrigin: string | null): Record<string, string> {
  const origin =
    requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : 'https://fundermatch.org';

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  };
}

// ── Download file from Supabase Storage ─────────────────────────────────────

async function downloadFile(
  supabase: ReturnType<typeof createClient>,
  path: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const { data, error } = await supabase.storage
    .from('grant-uploads')
    .download(path);

  if (error || !data) {
    console.error(`Failed to download ${path}:`, error?.message);
    return null;
  }

  const bytes = new Uint8Array(await data.arrayBuffer());

  // Infer mime type from extension
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
  };

  return { bytes, mimeType: mimeMap[ext] || 'text/plain' };
}

// ── SSE helpers ─────────────────────────────────────────────────────────────

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseDone(): string {
  return 'data: [DONE]\n\n';
}

function ssePhase(phase: string): string {
  return sseEvent({ phase });
}

// ── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const headers = {
    ...corsHeaders(origin),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(origin) });
  }

  // Per-IP rate limit (FM-2026-06-10-03): authenticated denial-of-wallet
  // protection for the grant-writer endpoint.
  const _ipLimit = await ipRateLimit(req, {
    namespace: 'grant-writer',
    limit: 10,
  });
  if (!_ipLimit.allow && _ipLimit.response) return _ipLimit.response;


  try {
    // Verify user is authenticated
    const { userId } = await authFromRequest(req);
    const supabase = adminClient();

    const body = await req.json();
    const funder = body.funder;
    const mission = typeof body.mission === 'string' ? body.mission.trim() : '';
    const orgDetails = body.orgDetails || {};
    const requestedFilePaths: string[] = Array.isArray(body.uploadedFilePaths)
      ? (body.uploadedFilePaths as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        )
      : [];

    if (!funder || !mission) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: funder, mission' }),
        { status: 400, headers: corsHeaders(origin) },
      );
    }

    // ── Authorize uploaded storage paths ──────────────────────────────────
    //
    // SECURITY (BOLA / IDOR — OWASP API1:2023, A01:2021, CWE-639, CWE-285,
    // CWE-22): `uploadedFilePaths` is fully attacker-controlled and every
    // download below runs under the service-role client, which bypasses
    // storage RLS entirely. The frontend uploads transient session files to
    // the `grant-uploads` bucket using the path convention
    // `${sessionId}/${uuid}.${ext}`, where `sessionId` is a client-side
    // random UUID — the path contains NO user identifier, so it proves
    // nothing about ownership and these objects are never recorded in
    // `application_knowledge_base`. The authoritative owner is the auth uid
    // Supabase Storage records on the object row when the file is uploaded
    // through the authenticated browser client. We verify every requested
    // path is owned by the caller via a service-role lookup against
    // `storage.objects` before any download. Any path that is missing,
    // malformed, or not owned by the caller fails the whole request with a
    // clear error — files are never silently dropped.
    const validatedFilePaths: string[] = [];
    if (requestedFilePaths.length > 0) {
      // Shape must match the upload convention (`<folder>/<file>`, exactly
      // two non-empty segments) with no traversal. Off-shape paths can never
      // be owned, so they fall through to the rejection below.
      const SHAPE_RE = /^[^/]+\/[^/]+$/;
      const wellFormed = requestedFilePaths.filter(
        (p) =>
          p.length > 0 &&
          p.length <= 512 &&
          !p.includes('..') &&
          !p.startsWith('/') &&
          SHAPE_RE.test(p),
      );

      // `userId` is the verified JWT `sub`; it must be a UUID before we
      // build a PostgREST filter from it. Bail closed if that invariant
      // ever breaks rather than issuing a query with an unexpected value.
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          userId,
        )
      ) {
        throw new Error('Unexpected authenticated user id format');
      }

      let ownedNames = new Set<string>();
      if (wellFormed.length > 0) {
        const { data: objs, error: objErr } = await supabase
          .schema('storage')
          .from('objects')
          .select('name, owner, owner_id')
          .eq('bucket_id', 'grant-uploads')
          .in('name', wellFormed);

        if (objErr) {
          console.error(
            'grant-writer: storage ownership lookup failed:',
            objErr.message,
          );
          return new Response(
            JSON.stringify({
              error:
                'Unable to verify your uploaded files right now. Please try again in a moment.',
            }),
            {
              status: 503,
              headers: {
                ...corsHeaders(origin),
                'Content-Type': 'application/json',
              },
            },
          );
        }

        ownedNames = new Set(
          ((objs ?? []) as Array<{
            name: string;
            owner: string | null;
            owner_id: string | null;
          }>)
            .filter((o) => o.owner === userId || o.owner_id === userId)
            .map((o) => o.name),
        );
      }

      const accepted = requestedFilePaths.filter((p) => ownedNames.has(p));
      if (accepted.length !== requestedFilePaths.length) {
        console.warn(
          `grant-writer: rejecting request — user ${userId} referenced ` +
            `${requestedFilePaths.length - accepted.length} storage path(s) ` +
            `that are malformed or not owned by them`,
        );
        return new Response(
          JSON.stringify({
            error:
              'Some uploaded files could not be verified as belonging to you. Please re-upload your files and try again.',
          }),
          {
            status: 403,
            headers: {
              ...corsHeaders(origin),
              'Content-Type': 'application/json',
            },
          },
        );
      }

      validatedFilePaths.push(...accepted);
    }

    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }),
        { status: 500, headers: corsHeaders(origin) },
      );
    }

    // ── Stream response ───────────────────────────────────────────────────
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (data: string) => controller.enqueue(enc.encode(data));

        try {
          // ── Phase 1: Extract text from uploaded grants (if any) ────────
          let styleGuide: StyleGuide | null = null;

          if (validatedFilePaths.length > 0) {
            send(ssePhase('analyzing'));

            const grantTexts: string[] = [];

            for (const path of validatedFilePaths.slice(0, 3)) {
              // Ownership was authoritatively verified above before this
              // service-role download is allowed to run.
              const file = await downloadFile(supabase, path);
              if (file) {
                try {
                  const text = await extractText(file.bytes, file.mimeType);
                  if (text.length > 100) grantTexts.push(text);
                } catch (err) {
                  console.error(`Text extraction failed for ${path}:`, err);
                }
              }
            }

            if (grantTexts.length > 0) {
              styleGuide = await analyzeStyle(grantTexts, ANTHROPIC_API_KEY);
              if (styleGuide) {
                send(sseEvent({ styleAnalysis: true, sections: styleGuide.sectionOrder.length }));
              }
            }
          }

          // ── Phase 2: Deep research ──────────────────────────────────────
          send(ssePhase('researching'));

          let research: ResearchData | null = null;
          try {
            research = await performResearch(
              mission,
              orgDetails.geoFocus || '',
              orgDetails.targetPop || '',
              TAVILY_API_KEY || undefined,
              ANTHROPIC_API_KEY,
            );
            send(
              sseEvent({
                researchComplete: true,
                statsFound: research.statistics.length,
                sourcesFound: research.findings.length,
                fallback: research.fallbackUsed,
              }),
            );
          } catch (err) {
            console.error('Research failed:', err);
            // Continue without research
          }

          // ── Phase 3: Build prompt and stream Claude response ────────────
          send(ssePhase('generating'));

          const { system, userMessage } = buildPrompt(
            funder,
            mission,
            orgDetails,
            styleGuide,
            research,
          );

          const claudeResponse = await fetch(
            'https://api.anthropic.com/v1/messages',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 8192,
                temperature: 0.7,
                stream: true,
                system,
                messages: [{ role: 'user', content: userMessage }],
              }),
            },
          );

          if (!claudeResponse.ok) {
            const errBody = await claudeResponse.text();
            console.error('Claude API error:', claudeResponse.status, errBody);
            send(sseEvent({ error: `AI generation failed (${claudeResponse.status})` }));
            send(sseDone());
            controller.close();
            return;
          }

          // Parse Claude SSE stream
          const reader = claudeResponse.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done: readerDone, value } = await reader.read();
            if (readerDone) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;

              try {
                const parsed = JSON.parse(data);

                if (parsed.type === 'content_block_delta') {
                  const text = parsed.delta?.text;
                  if (text) {
                    send(sseEvent({ text }));
                  }
                }

                if (parsed.type === 'message_stop') {
                  // Generation complete
                }
              } catch {
                // Ignore parse errors from partial chunks
              }
            }
          }

          send(sseDone());
        } catch (err) {
          console.error('Stream error:', err);
          send(
            sseEvent({
              error: 'Generation failed',
            }),
          );
          send(sseDone());
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Request error:', message);

    // Detect auth-related errors specifically; everything else is a server error.
    const isAuthError = /authorization|jwt|token|unauthorized|missing.*auth/i.test(message);
    const status = isAuthError ? 401 : 500;
    const userMessage = isAuthError
      ? 'Your session has expired. Please sign in again to continue.'
      : 'Something went wrong while preparing your draft. Please try again in a moment.';

    return new Response(
      JSON.stringify({ error: userMessage }),
      { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } },
    );
  }
});
