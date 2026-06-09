---
title: Explicit DOMPurify allowlist in GrantWriter renderer
finding-id: FM-2026-06-06-02, FM-2026-06-09-01
tsc: CC6.1, CC7.1
date: 2026-06-09
owner: Kevin Armstrong
status: closed
---

# Explicit DOMPurify allowlist in GrantWriter renderer

## Finding

Scheduled pen-test 2026-06-09 — Informational, defense-in-depth.

`src/pages/GrantWriter.tsx` line 1008 rendered AI-generated grant
output via `dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(
renderMarkdown(output)) }}`.

`renderMarkdown` already runs the assembled HTML through DOMPurify
with an explicit `ALLOWED_TAGS` / `ALLOWED_ATTR` allowlist
(`h2`, `h3`, `p`, `span`, `div`, `strong`, `em`, `hr`, `br` + `class`).
The second pass at the renderer used DOMPurify's **default profile**.
Today the defaults are a superset of the helper's allowlist, so the
combination is safe — but it leaves the renderer's safety posture
implicit at the call site. Two failure modes follow:

1. A future DOMPurify default-config change (e.g. permitting an
   attribute we did not anticipate) would silently widen the
   renderer's allowed surface.
2. A maintainer editing `renderMarkdown` to drop the tight allowlist
   (e.g. while debugging a rendering bug) would lose the only
   explicit allowlist on the chain — the renderer's
   `DOMPurify.sanitize(...)` call would still appear "safe" in code
   review because it is still calling DOMPurify.

This is the issue the 2026-06-06 pen-test (FM-2026-06-06-02) recommended
addressing.

## Resolution

The renderer now passes the same explicit `ALLOWED_TAGS` /
`ALLOWED_ATTR` allowlist that `renderMarkdown` uses, and a JSX comment
documents that the duplication is intentional (a single, auditable
allowlist that both layers share). The wire-level / DOM output is
unchanged for the current `renderMarkdown` output set.

## Verification

1. Manual: render a typical AI grant-draft output; the produced HTML
   contains only `<h2>`, `<h3>`, `<p>`, `<span class>`, `<div class>`,
   `<strong>`, `<em>`, `<hr>`, `<br>`.
2. Negative test: inject `<script>`, `<iframe>`, `<img onerror>`, and
   inline event handlers into the input — all are stripped at both
   layers (the helper layer first, the renderer layer as a backstop).
3. Future-proof: if `renderMarkdown` is ever edited to widen its
   allowlist, the renderer's second pass still clamps the surface
   down to the eight tags above.

## References

- OWASP Cheat Sheet: DOM-Based XSS Prevention
- CWE-79 — Improper Neutralization of Input During Web Page Generation
- DOMPurify config reference: https://github.com/cure53/DOMPurify#can-i-configure-dompurify
- Internal: `compliance/pentest-2026-06-06.md` (FM-2026-06-06-02)
- Internal: `compliance/prompt-injection-guard-2026-05-23.md` — companion
  control on the AI input side; this PR addresses the output side.
