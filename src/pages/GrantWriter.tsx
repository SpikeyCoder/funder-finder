import { useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Check, ChevronDown, ChevronUp, Copy, Loader2, RefreshCw, Wand2,
} from 'lucide-react';
import { Funder } from '../types';
import { formatGrantRange, formatTotalGiving } from '../utils/matching';

const GRANT_WRITER_URL =
  'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/grant-writer';

// ── Types ────────────────────────────────────────────────────────────────────

interface OrgDetails {
  orgName: string;
  orgDesc: string;
  budget: string;
  targetPop: string;
  geoFocus: string;
  programName: string;
  programDesc: string;
  programBudget: string;
  outcomes: string;
  timeline: string;
}

// ── Markdown renderer ────────────────────────────────────────────────────────

/**
 * Converts a subset of Markdown to safe HTML.
 * HTML-escapes the raw text first to prevent XSS, then applies block/inline rules.
 */
function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const parts: string[] = [];

  for (const rawLine of lines) {
    // Step 1: HTML-escape so funder/user data can't inject tags
    const esc = rawLine
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Step 2: inline bold (**text**)
    const inl = esc.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-white">$1</strong>');

    // Step 3: block-level detection (use rawLine for startsWith checks)
    if (rawLine.startsWith('### ')) {
      parts.push(
        `<h3 class="text-base font-bold text-white mt-7 mb-2 pb-1 border-b border-[#30363d]">${inl.slice(4)}</h3>`,
      );
    } else if (rawLine.startsWith('## ')) {
      parts.push(
        `<h2 class="text-xl font-bold text-blue-400 mt-10 mb-3 first:mt-0">${inl.slice(3)}</h2>`,
      );
    } else if (rawLine === '---') {
      parts.push('<hr class="border-[#30363d] my-6">');
    } else if (rawLine.startsWith('- [x] ')) {
      parts.push(
        `<div class="flex items-start gap-2 my-1.5 text-sm">` +
          `<span class="text-green-400 font-bold shrink-0 mt-0.5">✓</span>` +
          `<span class="text-gray-300">${inl.slice(6)}</span></div>`,
      );
    } else if (rawLine.startsWith('- [ ] ')) {
      parts.push(
        `<div class="flex items-start gap-2 my-1.5 text-sm">` +
          `<span class="text-gray-400 shrink-0 mt-0.5">○</span>` +
          `<span class="text-gray-300">${inl.slice(6)}</span></div>`,
      );
    } else if (rawLine.startsWith('  - ')) {
      // Indented bullet (sub-objective)
      parts.push(
        `<div class="flex items-start gap-2 ml-5 my-1 text-sm">` +
          `<span class="text-gray-400 shrink-0 mt-0.5">–</span>` +
          `<span class="text-gray-400">${inl.slice(4)}</span></div>`,
      );
    } else if (rawLine.startsWith('- ')) {
      parts.push(
        `<div class="flex items-start gap-2 my-1.5 text-sm">` +
          `<span class="text-gray-400 shrink-0 mt-0.5">•</span>` +
          `<span class="text-gray-300">${inl.slice(2)}</span></div>`,
      );
    } else if (rawLine === '') {
      parts.push('<div class="h-1.5"></div>');
    } else {
      parts.push(`<p class="text-gray-300 leading-relaxed text-sm">${inl}</p>`);
    }
  }

  return parts.join('');
}

// ── Component ────────────────────────────────────────────────────────────────

export default function GrantWriter() {
  const location = useLocation();
  const navigate = useNavigate();

  const funder: Funder | null = (location.state as any)?.funder ?? null;

  // Redirect if no funder in router state
  useEffect(() => {
    if (!funder) navigate('/saved', { replace: true });
  }, [funder, navigate]);

  // Pre-fill mission and location from sessionStorage
  const [mission, setMission] = useState(
    () => sessionStorage.getItem('ff_mission') || '',
  );
  const [orgDetails, setOrgDetails] = useState<OrgDetails>({
    orgName: '',
    orgDesc: '',
    budget: '',
    targetPop: '',
    geoFocus: sessionStorage.getItem('ff_location') || '',
    programName: '',
    programDesc: '',
    programBudget: '',
    outcomes: '',
    timeline: '',
  });

  const [showOrg, setShowOrg] = useState(false);
  const [showProgram, setShowProgram] = useState(false);

  const [output, setOutput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const outputEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom during streaming
  useEffect(() => {
    if (streaming) {
      outputEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [output, streaming]);

  const updateOrg = (key: keyof OrgDetails, value: string) => {
    setOrgDetails(prev => ({ ...prev, [key]: value }));
  };

  // ── Generate ───────────────────────────────────────────────────────────────

  const generate = async () => {
    if (!funder || !mission.trim() || streaming) return;

    setOutput('');
    setDone(false);
    setError(null);
    setStreaming(true);

    try {
      const response = await fetch(GRANT_WRITER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funder, mission, orgDetails }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Server error (${response.status})`);
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
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
          if (data === '[DONE]') {
            setDone(true);
            setStreaming(false);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text) setOutput(prev => prev + parsed.text);
          } catch (parseErr) {
            if (parseErr instanceof Error && parseErr.message !== 'Unexpected end of JSON input') {
              throw parseErr;
            }
          }
        }
      }

      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate grant draft');
    } finally {
      setStreaming(false);
    }
  };

  const copyOutput = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    setOutput('');
    setDone(false);
    setError(null);
  };

  // ── Helpers ────────────────────────────────────────────────────────────────

  const inputClass =
    'w-full bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600';

  const labelClass = 'block text-xs text-gray-400 mb-1';

  if (!funder) return null;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-3xl mx-auto">

        {/* Back */}
        <button
          onClick={() => navigate('/saved')}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors"
        >
          <ArrowLeft size={18} />
          Back to Saved Funders
        </button>

        {/* Page title */}
        <h1 className="text-3xl font-bold mb-1">AI Grant Writer</h1>
        <p className="text-gray-400 mb-8 text-sm">
          Generate a tailored grant application draft powered by Claude.
        </p>

        {/* Funder context card */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-5 mb-7">
          <p className="text-xs text-gray-400 mb-1">Writing grant for</p>
          <h2 className="text-xl font-bold">{funder.name}</h2>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-400 mt-2">
            <span className="capitalize">{funder.type}</span>
            {funder.state && (
              <span>{funder.city ? `${funder.city}, ` : ''}{funder.state}</span>
            )}
            {(funder.grant_range_min || funder.grant_range_max) && (
              <span className="text-green-400">Grants: {formatGrantRange(funder)}</span>
            )}
            {funder.total_giving && (
              <span className="text-blue-400">{formatTotalGiving(funder.total_giving)} total giving</span>
            )}
          </div>
          {funder.focus_areas?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {funder.focus_areas.map((area, i) => (
                <span
                  key={i}
                  className="text-xs bg-[#21262d] border border-[#30363d] text-gray-300 px-2 py-0.5 rounded-full"
                >
                  {area}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── Form (shown before / after generation) ── */}
        {!streaming && !done && (
          <div className="space-y-5">

            {/* Mission */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Mission Statement <span className="text-red-400">*</span>
              </label>
              <textarea
                className="w-full bg-[#161b22] border border-[#30363d] rounded-xl px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 resize-none"
                rows={4}
                placeholder="Describe your nonprofit's mission and the communities you serve…"
                value={mission}
                onChange={e => setMission(e.target.value)}
              />
            </div>

            {/* Organization Details (collapsible) */}
            <div className="border border-[#30363d] rounded-xl overflow-hidden">
              <button
                onClick={() => setShowOrg(prev => !prev)}
                className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium hover:bg-[#161b22] transition-colors text-left"
              >
                <span className="text-gray-300">
                  Organization Details{' '}
                  <span className="text-gray-400 font-normal">(optional — improves quality)</span>
                </span>
                {showOrg
                  ? <ChevronUp size={16} className="text-gray-400 shrink-0" />
                  : <ChevronDown size={16} className="text-gray-400 shrink-0" />}
              </button>

              {showOrg && (
                <div className="px-5 pb-5 bg-[#0d1117] grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Organization Name</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Community Youth Alliance"
                      value={orgDetails.orgName}
                      onChange={e => updateOrg('orgName', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Annual Operating Budget</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. $500,000"
                      value={orgDetails.budget}
                      onChange={e => updateOrg('budget', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Target Population</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Youth ages 12–18 in low-income communities"
                      value={orgDetails.targetPop}
                      onChange={e => updateOrg('targetPop', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Geographic Focus</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Greater Boston, MA"
                      value={orgDetails.geoFocus}
                      onChange={e => updateOrg('geoFocus', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass}>Organization Description</label>
                    <textarea
                      className={`${inputClass} resize-none`}
                      rows={2}
                      placeholder="Brief description of your organization's history, programs, and impact…"
                      value={orgDetails.orgDesc}
                      onChange={e => updateOrg('orgDesc', e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Program Details (collapsible) */}
            <div className="border border-[#30363d] rounded-xl overflow-hidden">
              <button
                onClick={() => setShowProgram(prev => !prev)}
                className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium hover:bg-[#161b22] transition-colors text-left"
              >
                <span className="text-gray-300">
                  Program / Project Details{' '}
                  <span className="text-gray-400 font-normal">(optional — improves specificity)</span>
                </span>
                {showProgram
                  ? <ChevronUp size={16} className="text-gray-400 shrink-0" />
                  : <ChevronDown size={16} className="text-gray-400 shrink-0" />}
              </button>

              {showProgram && (
                <div className="px-5 pb-5 bg-[#0d1117] grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Program / Project Name</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Summer STEM Academy"
                      value={orgDetails.programName}
                      onChange={e => updateOrg('programName', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Amount Requested</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. $50,000"
                      value={orgDetails.programBudget}
                      onChange={e => updateOrg('programBudget', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Project Timeline</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. 12-month program, July 2025 – June 2026"
                      value={orgDetails.timeline}
                      onChange={e => updateOrg('timeline', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Anticipated Outcomes</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Serve 200 youth, 80% improve STEM skills"
                      value={orgDetails.outcomes}
                      onChange={e => updateOrg('outcomes', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass}>Program Description</label>
                    <textarea
                      className={`${inputClass} resize-none`}
                      rows={3}
                      placeholder="Describe the specific program or project you're seeking funding for…"
                      value={orgDetails.programDesc}
                      onChange={e => updateOrg('programDesc', e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="bg-red-900/20 border border-red-800 rounded-xl px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            {/* Generate button */}
            <button
              onClick={generate}
              disabled={!mission.trim() || streaming}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-[#161b22] disabled:text-gray-600 disabled:cursor-not-allowed text-white font-semibold py-4 rounded-xl transition-colors text-base"
            >
              <Wand2 size={18} />
              Generate Grant Draft
            </button>

            <p className="text-xs text-gray-400 text-center">
              More details = better output. The draft uses [BRACKETS] where specific data is needed.
            </p>
          </div>
        )}

        {/* ── Streaming indicator ── */}
        {streaming && (
          <div className="flex items-center gap-3 py-2 text-blue-400 text-sm">
            <Loader2 size={16} className="animate-spin" />
            Writing your grant application for {funder.name}…
          </div>
        )}

        {/* ── Output ── */}
        {output && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Your Grant Draft</h2>
              {done && (
                <div className="flex gap-2">
                  <button
                    onClick={copyOutput}
                    className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
                  >
                    {copied
                      ? <Check size={14} className="text-green-400" />
                      : <Copy size={14} />}
                    {copied ? 'Copied!' : 'Copy All'}
                  </button>
                  <button
                    onClick={reset}
                    className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
                  >
                    <RefreshCw size={14} />
                    Re-generate
                  </button>
                </div>
              )}
            </div>

            <div
              className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }}
            />

            {/* Scroll anchor + inline streaming indicator */}
            {streaming && (
              <div className="flex items-center gap-2 mt-3 text-sm text-blue-400">
                <Loader2 size={14} className="animate-spin" />
                Generating…
              </div>
            )}
            <div ref={outputEndRef} />

            {done && (
              <p className="text-xs text-gray-300 text-center mt-4">
                Replace all [BRACKETS] with your organization's real data before submitting.
              </p>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
