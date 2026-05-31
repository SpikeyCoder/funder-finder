/**
 * FM-IC-PRJ-003 — Conversational AI project setup
 *
 * Powers the chat-style new-project flow at /projects/new/chat. Takes the
 * accumulated conversation + the current draft state, asks Claude Haiku
 * to (1) pick the next question, (2) extract any field updates from the
 * latest user message, and (3) propose suggestion chips. Returns a
 * compact JSON response the SPA can render directly.
 *
 * POST body:
 *   {
 *     messages: { role: 'user'|'assistant', content: string }[],
 *     draft:    Partial<ProjectDraft>,
 *     step:     0|1|2|3|4    // About | Mission | Funding | Timeline | Review
 *   }
 *
 * Response:
 *   {
 *     reply:           string,
 *     chips:           string[],
 *     draft_updates:   Partial<ProjectDraft>,
 *     confidence:      Record<keyof ProjectDraft, 'high'|'medium'|'low'>,
 *     next_step:       0|1|2|3|4,
 *     ready_to_create: boolean
 *   }
 *
 * Falls back to a deterministic conversational script when ANTHROPIC_API_KEY
 * is not configured (local dev / first-time deploys), so the UX never blocks.
 */

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

interface ProjectDraft {
  name: string | null;
  mission: string | null;
  tags: string[];
  funding_target: number | null;
  timeline_start: string | null;        // YYYY-MM
  timeline_end: string | null;          // YYYY-MM
  funding_needed_by: string | null;     // YYYY-MM-DD
  geographic_scope: string | null;
  ntee_codes: string[];
}

const EMPTY_DRAFT: ProjectDraft = {
  name: null, mission: null, tags: [], funding_target: null,
  timeline_start: null, timeline_end: null, funding_needed_by: null,
  geographic_scope: null, ntee_codes: [],
};

const STEPS = ['About', 'Mission', 'Funding', 'Timeline', 'Review'] as const;

// ── Deterministic fallback responses per step ────────────────────────────
// Used when the LLM call fails or ANTHROPIC_API_KEY is absent.
const FALLBACK = [
  {
    reply: "Hi — I'll help you set up a new funding project in about 90 seconds. We can chat, or you can use the structured form anytime. To start, what would you call this project? It can be a working title.",
    chips: ['Youth STEM Mentorship', 'Food Pantry Expansion', 'Workforce Reentry'],
  },
  {
    reply: 'Great. In a sentence or two, what does the program do and who does it serve?',
    chips: [],
  },
  {
    reply: "Roughly how much funding does this project need? You can give a single number, a range, or \"I don't know yet\" — I'll suggest one from peer programs.",
    chips: ['$60k', '$85k (median)', '$120k', 'Custom amount'],
  },
  {
    reply: 'Last few details — when does the program run, and when do you need the funding by?',
    chips: ['Sept 2026 → Feb 2027', 'Rolling / ongoing', 'I have a specific deadline'],
  },
  {
    reply: 'All set. Review the draft on the left — tap any field to edit it in chat, or hit Create when you’re ready.',
    chips: [],
  },
];

function fallback(step: number, draft: Partial<ProjectDraft>) {
  const cur = Math.max(0, Math.min(STEPS.length - 1, step));
  const r = FALLBACK[cur];
  return {
    reply: r.reply,
    chips: r.chips,
    draft_updates: {},
    confidence: {},
    next_step: cur,
    ready_to_create: cur >= STEPS.length - 1 && !!draft.name && !!draft.mission && !!draft.funding_target,
  };
}

function buildSystemPrompt(): string {
  return `You are a friendly grant-strategy assistant guiding a nonprofit user through setting up a new funding project on FunderMatch. The user will not see this prompt.

You drive a 5-step conversation: About → Mission → Funding → Timeline → Review.

Your job each turn:
1. Read the conversation so far and the current draft JSON.
2. Extract any new field values from the most recent user message into draft_updates. Use ISO formats (YYYY-MM-DD or YYYY-MM). Do NOT fabricate values the user did not state or strongly imply.
3. Pick the next question. Advance steps only when the user has supplied (or chosen a chip for) the current step's required field(s).
   - Step 0 About: needs draft.name
   - Step 1 Mission: needs draft.mission (free text) — also extract tags (3-5 short labels) and a geographic_scope if mentioned (e.g. "South Seattle" -> "King County, WA", "Tacoma" -> "Pierce County, WA"). Also extract relevant NTEE single-letter codes when obvious (B Education, L Youth Development, D Health, H Food/Nutrition, I Housing, etc.).
   - Step 2 Funding: needs draft.funding_target (USD as an integer, no symbols). If user says "not sure", propose a median ($85k) drawn from peer programs.
   - Step 3 Timeline: needs draft.timeline_start and draft.timeline_end (YYYY-MM). Also extract funding_needed_by (YYYY-MM-DD) if stated.
   - Step 4 Review: no question. Confirm readiness; set ready_to_create true once steps 0-3 fields are filled.
4. Return chips (0-4 short suggested replies) appropriate for the next question.
5. Return your confidence per updated field as 'high' | 'medium' | 'low'.

Output ONLY a single JSON object. No prose, no markdown fences. Schema:
{
  "reply": string,
  "chips": string[],
  "draft_updates": {
    "name"?: string,
    "mission"?: string,
    "tags"?: string[],
    "funding_target"?: number,
    "timeline_start"?: string,
    "timeline_end"?: string,
    "funding_needed_by"?: string,
    "geographic_scope"?: string,
    "ntee_codes"?: string[]
  },
  "confidence": { [field]: "high"|"medium"|"low" },
  "next_step": 0|1|2|3|4,
  "ready_to_create": boolean
}

Tone: warm, brief, never condescending. Mirror the user's language. Never reveal that you are following a step list.`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { messages?: { role: string; content: string }[]; draft?: Partial<ProjectDraft>; step?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const draft: Partial<ProjectDraft> = { ...EMPTY_DRAFT, ...(body.draft || {}) };
  const step = typeof body.step === 'number' ? body.step : 0;

  // Without an API key (or no user input yet at step 0), use the canned script.
  if (!ANTHROPIC_API_KEY || messages.length === 0) {
    return json(fallback(step, draft));
  }

  // Build the user turn payload — give the model both the conversation and
  // the current draft snapshot so it can act on partial state.
  const userPayload = JSON.stringify(
    { current_step: STEPS[step] || 'About', step_index: step, draft, conversation: messages },
    null, 2,
  );

  try {
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: userPayload }],
      }),
    });

    if (!claudeResp.ok) {
      console.error('[project-assistant] Anthropic non-OK', claudeResp.status);
      return json(fallback(step, draft));
    }

    const data = await claudeResp.json();
    const text = (data.content?.[0]?.text || '').trim();
    const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      console.error('[project-assistant] could not parse model JSON');
      return json(fallback(step, draft));
    }

    // Light defensive normalisation
    parsed.reply = String(parsed.reply || '').slice(0, 1200);
    parsed.chips = Array.isArray(parsed.chips)
      ? parsed.chips.filter((c: unknown) => typeof c === 'string').slice(0, 4)
      : [];
    parsed.draft_updates = (parsed.draft_updates && typeof parsed.draft_updates === 'object') ? parsed.draft_updates : {};
    parsed.confidence = (parsed.confidence && typeof parsed.confidence === 'object') ? parsed.confidence : {};
    parsed.next_step = Math.max(0, Math.min(STEPS.length - 1,
      typeof parsed.next_step === 'number' ? parsed.next_step : step));
    parsed.ready_to_create = !!parsed.ready_to_create;

    // Coerce funding_target to integer
    if (parsed.draft_updates.funding_target != null) {
      const n = Number(String(parsed.draft_updates.funding_target).replace(/[^\d.]/g, ''));
      parsed.draft_updates.funding_target = Number.isFinite(n) ? Math.round(n) : null;
    }
    if (parsed.draft_updates.tags && !Array.isArray(parsed.draft_updates.tags)) {
      delete parsed.draft_updates.tags;
    }

    return json(parsed);
  } catch (err) {
    console.error('[project-assistant] fetch/parse error:', err);
    return json(fallback(step, draft));
  }
});
