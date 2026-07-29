// RECOVERED 2026-07-29 (FM-2026-07-29-02) from the deployed Edge Function.
// Live in production (v9, deployed 2026-04-30) with NO source in this repo.
// Body below is the deployed source verbatim; only this header was added.
//
// NOTE: this is already a tombstone — it returns 410 Gone and does nothing. It
// is a disabled remnant of an automated bug-fixer helper. Recovered so the repo
// reflects what is actually deployed; the cleaner end state is to DELETE the
// function from the project rather than carry a stub. Left deployed here because
// deleting a live function is not something to do as a side effect of a recovery.
//
// CAVEAT: the leading underscore means `supabase functions deploy` (no args)
// skips this directory, matching the `_shared` convention. Deploy it explicitly
// by name if it ever needs to change.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Disabled: temporary helper used by automated bug-fixer; locked behind JWT.
Deno.serve(() => new Response(JSON.stringify({ disabled: true }), { status: 410, headers: { 'Content-Type': 'application/json' } }));
