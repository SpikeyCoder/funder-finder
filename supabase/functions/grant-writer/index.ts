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
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { extractText } from './text-extract.ts';
import { analyzeStyle, type StyleGuide } from './style-analysis.ts';
import { performResearch, type ResearchData } from './research.ts';
import { buildPrompt } from './prompt-builder.ts';

// ── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const TAVILY_API_KEY = Deno.env.get('TAVILY_API_KEY') || '';

const ALLOWED_ORIGINS = new Set([
  'https://fundermatch.org',
  'https://www.fundermatch.org',
  'https://spikeycoder.github.io',
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

// ── Supabase client (service role for storage access) ───────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Download file from Supabase Storage ─────────────────────────────────────

async function downloadFile(
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

  try {
    const body = await req.json();
    const funder = body.funder;
    const mission = typeof body.mission === 'string' ? body.mission.trim() : '';
    const orgDetails = body.orgDetails || {};
    const uploadedFilePaths: string[] = body.uploadedFilePaths || [];

    if (!funder || !mission) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: funder, mission' }),
        { status: 400, headers: corsHeaders(origin) },
      );
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

          if (uploadedFilePaths.length > 0) {
            send(ssePhase('analyzing'));

            const grantTexts: string[] = [];

            for (const path of uploadedFilePaths.slice(0, 3)) {
              const file = await downloadFile(path);
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
              error: err instanceof Error ? err.message : 'Generation failed',
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
    console.error('Request error:', err);
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : 'Internal error',
      }),
      { status: 500, headers: corsHeaders(origin) },
    );
  }
});
