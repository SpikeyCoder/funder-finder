/**
 * FM-IC-PRJ-003 — Conversational AI project setup
 *
 * Implements the chat-style new-project flow designed in Figma:
 *   https://www.figma.com/design/kdibkG24nw78IWImGQEgQU
 *
 * Layout per frame: NavBar + eyebrow/title + 5-step progress + two-column
 * body (chat 760px, draft side-panel 400px) + composer. The Review and
 * Success frames swap the chat column for summary content but keep the
 * same chrome.
 *
 * State machine driven by the `project-assistant` edge function; users
 * can switch to the structured form at any time via the escape-hatch
 * link in the side panel. Project creation reuses the same supabase
 * insert + match-funders pipeline as NewProjectPage.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUp, Loader, Sparkles, Check, Edit3, ArrowLeft,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const ASSISTANT_URL = `${SUPABASE_URL}/functions/v1/project-assistant`;
const MATCH_FUNDERS_URL = `${SUPABASE_URL}/functions/v1/match-funders`;

const STEPS = ['About', 'Mission', 'Funding', 'Timeline', 'Review'] as const;
type StepIndex = 0 | 1 | 2 | 3 | 4;

interface ChatMessage {
  role: 'assistant' | 'user';
  content: string;
}

interface ProjectDraft {
  name: string | null;
  mission: string | null;
  tags: string[];
  funding_target: number | null;
  timeline_start: string | null;
  timeline_end: string | null;
  funding_needed_by: string | null;
  geographic_scope: string | null;
  ntee_codes: string[];
}

interface AssistantResponse {
  reply: string;
  chips: string[];
  draft_updates: Partial<ProjectDraft>;
  confidence: Record<string, 'high' | 'medium' | 'low'>;
  next_step: StepIndex;
  ready_to_create: boolean;
}

const EMPTY_DRAFT: ProjectDraft = {
  name: null, mission: null, tags: [], funding_target: null,
  timeline_start: null, timeline_end: null, funding_needed_by: null,
  geographic_scope: null, ntee_codes: [],
};

const STEP_COPY: { eyebrow: string; title: string; placeholder: string }[] = [
  { eyebrow: 'New project · Conversational', title: 'Let’s set up your project, together.', placeholder: 'Type your project name or pick a suggestion…' },
  { eyebrow: 'New project · Conversational', title: 'Tell me what the program does.',          placeholder: 'Reply or pick a chip…' },
  { eyebrow: 'New project · Conversational', title: 'Let’s size the ask.',                     placeholder: 'Type a number or pick a chip…' },
  { eyebrow: 'New project · Conversational', title: 'When does the work happen?',              placeholder: 'Reply or pick a chip…' },
  { eyebrow: 'New project · Conversational', title: 'Ready to create?',                        placeholder: 'Reply…' },
];

function fmtMonth(ym: string | null) {
  if (!ym) return null;
  const [y, m] = ym.split('-');
  if (!y || !m) return ym;
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
function fmtCurrency(n: number | null) {
  if (n == null) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n.toLocaleString()}`;
}
function timelineSummary(d: ProjectDraft): string | null {
  const start = fmtMonth(d.timeline_start);
  const end = fmtMonth(d.timeline_end);
  if (!start && !end) return null;
  const range = start && end ? `${start} → ${end}` : start || end;
  const need = d.funding_needed_by
    ? `  ·  Funding by ${new Date(d.funding_needed_by).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';
  return `${range}${need}`;
}

function countFilled(d: ProjectDraft): number {
  let n = 0;
  if (d.name) n++;
  if (d.mission) n++;
  if (d.tags && d.tags.length > 0) n++;
  if (d.funding_target != null) n++;
  if (d.timeline_start || d.timeline_end) n++;
  if (d.funding_needed_by) n++;
  if (d.geographic_scope) n++;
  return n;
}

// ── Tiny presentational primitives ───────────────────────────────────────

function ProgressBar({ step }: { step: StepIndex }) {
  return (
    <div className="flex items-center mt-4 mb-8">
      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        const dotBg = done || active ? 'bg-blue-600 border-blue-600' : 'bg-[#161b22] border-[#30363d]';
        const dotText = done || active ? 'text-white' : 'text-gray-400';
        return (
          <div key={label} className="flex items-center">
            <div className={`w-6 h-6 rounded-full border flex items-center justify-center text-[11px] font-semibold ${dotBg} ${dotText}`}>
              {done ? <Check size={12} /> : i + 1}
            </div>
            <span className={`ml-2 text-xs font-medium ${active ? 'text-white' : 'text-gray-400'}`}>{label}</span>
            {i < STEPS.length - 1 && (
              <div className={`mx-3 h-0.5 w-16 ${done ? 'bg-blue-600' : 'bg-[#30363d]'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SideField({ label, value, filled, confidence }: { label: string; value: string | null; filled: boolean; confidence?: 'high' | 'medium' | 'low' }) {
  return (
    <div className="mb-4">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{label}</p>
      <div className={`bg-[#0d1117] border rounded-lg px-3 py-2 text-sm ${filled ? 'border-blue-500 text-white' : 'border-[#30363d] text-gray-400'}`}>
        {value || '—'}
      </div>
      {filled && confidence && (
        <p className={`text-[10px] mt-1 ${confidence === 'high' ? 'text-green-400' : confidence === 'medium' ? 'text-yellow-400' : 'text-gray-400'}`}>
          AI confidence: {confidence}
        </p>
      )}
    </div>
  );
}

function SideDraftPanel({ draft, confidence, onSwitchToForm }: { draft: ProjectDraft; confidence: Record<string, 'high' | 'medium' | 'low'>; onSwitchToForm: () => void }) {
  const filled = countFilled(draft);
  return (
    <aside className="bg-[#161b22] border border-[#30363d] rounded-xl p-5 h-full flex flex-col">
      <p className="text-sm font-semibold text-white">Project draft</p>
      <p className="text-[11px] text-gray-400 mb-3">Fills in as you chat ↓</p>
      <div className="h-px bg-[#30363d] -mx-5 mb-4" />
      <div className="flex-1 overflow-y-auto">
        <SideField label="Project name" value={draft.name} filled={!!draft.name} confidence={confidence.name} />
        <SideField label="Mission summary" value={draft.mission} filled={!!draft.mission} confidence={confidence.mission} />
        {draft.tags.length > 0 && (
          <SideField label="Tags" value={draft.tags.join(' · ')} filled confidence={confidence.tags} />
        )}
        <SideField label="Funding target" value={draft.funding_target != null ? `${fmtCurrency(draft.funding_target)} / yr` : null} filled={draft.funding_target != null} confidence={confidence.funding_target} />
        <SideField label="Timeline" value={timelineSummary(draft)} filled={!!(draft.timeline_start || draft.timeline_end)} confidence={confidence.timeline_start || confidence.timeline_end} />
        {draft.geographic_scope && (
          <SideField label="Geographic scope" value={draft.geographic_scope} filled confidence={confidence.geographic_scope} />
        )}
      </div>
      <div className="mt-3 pt-3 border-t border-[#30363d] flex flex-col gap-1.5">
        <p className="text-[11px] font-medium text-green-400">AI confidence: high  ·  {filled} fields filled</p>
        <button onClick={onSwitchToForm} className="text-[11px] font-medium text-blue-400 hover:text-blue-300 text-left">
          Prefer the structured form? Switch anytime →
        </button>
      </div>
    </aside>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'assistant') {
    return (
      <div className="flex items-start gap-3 mb-4">
        <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-none">
          <Sparkles size={12} className="text-white" />
        </div>
        <div className="bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 text-sm text-white max-w-[540px]">
          {msg.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-end mb-4">
      <div className="bg-blue-600 rounded-xl px-4 py-3 text-sm text-white max-w-[420px]">
        {msg.content}
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────

export default function ConversationalProjectSetup() {
  useEffect(() => {
    document.title = 'New Project · Chat | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Set up a new funding project by chatting with an AI assistant — peer-aware suggestions and a side draft panel that fills as you talk.';
  }, []);

  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState<StepIndex>(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [confidence, setConfidence] = useState<Record<string, 'high' | 'medium' | 'low'>>({});

  const [composerValue, setComposerValue] = useState('');
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [view, setView] = useState<'chat' | 'review' | 'success'>('chat');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [matchCounts, setMatchCounts] = useState<{ total: number; highFit: number; closingSoon: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Kick off the first assistant message on mount.
  useEffect(() => {
    if (messages.length === 0) {
      callAssistant([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to latest message.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, waitingForReply]);

  const callAssistant = async (nextMessages: ChatMessage[]) => {
    setWaitingForReply(true);
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(ASSISTANT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ messages: nextMessages, draft, step }),
      });
      if (!res.ok) throw new Error(`Assistant returned ${res.status}`);
      const data: AssistantResponse = await res.json();

      // Merge field updates into the draft
      if (data.draft_updates) {
        setDraft(d => {
          const merged: ProjectDraft = { ...d };
          for (const [k, v] of Object.entries(data.draft_updates)) {
            if (v != null && v !== '') (merged as any)[k] = v;
          }
          return merged;
        });
      }
      if (data.confidence) {
        setConfidence(c => ({ ...c, ...data.confidence }));
      }
      // Append AI reply
      setMessages([...nextMessages, { role: 'assistant', content: data.reply }]);
      setChips(data.chips || []);
      setStep(data.next_step);
      if (data.next_step >= 4 && data.ready_to_create) {
        setView('review');
      }
    } catch (err: any) {
      console.error(err);
      setError('Could not reach the assistant. Try again, or switch to the structured form.');
    } finally {
      setWaitingForReply(false);
    }
  };

  const sendUserMessage = (content: string) => {
    if (!content.trim() || waitingForReply) return;
    const next = [...messages, { role: 'user' as const, content: content.trim() }];
    setMessages(next);
    setComposerValue('');
    setChips([]);
    callAssistant(next);
  };

  const onChipClick = (chip: string) => sendUserMessage(chip);

  const onComposerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendUserMessage(composerValue);
  };

  const editField = (label: string) => {
    setView('chat');
    // Send a small directive message so the assistant routes the user back
    // to the relevant question. The model handles the actual flow.
    sendUserMessage(`I'd like to edit my ${label}.`);
  };

  const switchToStructuredForm = () => {
    // Carry partial state via sessionStorage so the structured form
    // can pre-fill known fields without a router round-trip.
    try {
      sessionStorage.setItem('fundermatch.project_draft', JSON.stringify(draft));
    } catch { /* ignore quota / privacy errors */ }
    navigate('/projects/new');
  };

  const createProject = async () => {
    if (!user || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { data, error: insertError } = await supabase
        .from('projects')
        .insert({
          user_id: user.id,
          name: (draft.name || 'Untitled project').trim(),
          description: draft.mission || null,
          location_scope: draft.geographic_scope ? [{ state: draft.geographic_scope }] : null,
          fields_of_work: draft.tags.length > 0 ? draft.tags : null,
          keywords: draft.tags.length > 0 ? draft.tags : null,
          budget_min: draft.funding_target || null,
          budget_max: draft.funding_target || null,
        })
        .select()
        .single();
      if (insertError) throw insertError;
      setCreatedProjectId(data.id);

      // Best-effort match computation; non-blocking.
      try {
        const headers = await getEdgeFunctionHeaders();
        const matchRes = await fetch(MATCH_FUNDERS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            mission: draft.mission || draft.name || '',
            locationServed: draft.geographic_scope || undefined,
            keywords: draft.tags.length > 0 ? draft.tags : undefined,
            budgetBand: draft.funding_target ? `${draft.funding_target}-${draft.funding_target}` : undefined,
          }),
        });
        if (matchRes.ok) {
          const m = await matchRes.json();
          const results = Array.isArray(m.results) ? m.results : [];
          const highFit = results.filter((r: any) => (r.fit_score || 0) >= 0.7).length;
          const closingSoon = results.filter((r: any) => r.next_deadline_within_30d).length;
          setMatchCounts({ total: results.length, highFit, closingSoon });
          if (results.length > 0) {
            const rows = results.slice(0, 50).map((r: any) => ({
              project_id: data.id,
              funder_ein: r.foundation_ein || r.id || '',
              funder_name: r.name || r.foundation_ein || '',
              match_score: Math.round((r.fit_score || 0) * 100),
              match_reasons: r.fit_explanation || null,
              gives_to_peers: !!r.gives_to_peers,
              computed_at: new Date().toISOString(),
            })).filter((r: any) => r.funder_ein);
            if (rows.length > 0) await supabase.from('project_matches').insert(rows);
          }
        }
      } catch (e) { console.warn('Match computation failed (non-blocking):', e); }

      setView('success');
    } catch (err: any) {
      console.error(err);
      setError(err?.message || 'Could not create project');
    } finally {
      setCreating(false);
    }
  };

  const copy = STEP_COPY[step];
  const headerEyebrow = view === 'success' ? 'New project · Created' : copy.eyebrow;
  const headerTitle =
    view === 'success' ? 'Project created' :
    view === 'review'  ? 'Ready to create?' :
    copy.title;

  if (authLoading) {
    return (
      <>
        <NavBar />
        <main className="min-h-screen bg-[#0d1117] pt-20 flex items-center justify-center">
          <Loader className="animate-spin text-gray-400" size={24} />
        </main>
      </>
    );
  }

  return (
    <>
      <NavBar />
      <main id="main-content" className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8 pb-12 text-white">
        <div className="max-w-7xl mx-auto">
          {/* Header */}
          <p className="text-[11px] font-semibold tracking-wider text-blue-500 mb-2">{headerEyebrow.toUpperCase()}</p>
          <h1 className="text-3xl font-semibold">{headerTitle}</h1>
          {view !== 'success' && <ProgressBar step={view === 'review' ? 4 : step} />}

          {error && (
            <div className="mb-4 bg-red-950/40 border border-red-700/60 text-red-300 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          {/* Body */}
          {view === 'chat' && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
              {/* Chat column */}
              <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 flex flex-col" style={{ minHeight: 560 }}>
                <div ref={scrollRef} className="flex-1 overflow-y-auto pr-2">
                  {messages.map((m, i) => <ChatBubble key={i} msg={m} />)}
                  {waitingForReply && (
                    <div className="flex items-center gap-3 text-gray-400 text-sm mb-4">
                      <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-none">
                        <Sparkles size={12} className="text-white" />
                      </div>
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse" />
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse [animation-delay:120ms]" />
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse [animation-delay:240ms]" />
                      </span>
                    </div>
                  )}
                  {!waitingForReply && chips.length > 0 && (
                    <div className="flex flex-wrap gap-2 ml-10 mb-2">
                      {chips.map(c => (
                        <button key={c} onClick={() => onChipClick(c)}
                          className="text-xs font-medium bg-[#0d1117] border border-[#484f58] hover:border-blue-500 text-white px-3 py-1.5 rounded-full transition-colors">
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <form onSubmit={onComposerSubmit} className="mt-4 flex items-center gap-2 bg-[#0d1117] border border-[#30363d] rounded-xl pl-4 pr-2 py-2">
                  <input
                    type="text"
                    value={composerValue}
                    onChange={e => setComposerValue(e.target.value)}
                    placeholder={copy.placeholder}
                    className="flex-1 bg-transparent text-sm text-white placeholder:text-gray-400 focus:outline-none"
                    disabled={waitingForReply}
                    aria-label="Message to project setup assistant"
                  />
                  <button type="submit" aria-label="Send message" disabled={!composerValue.trim() || waitingForReply}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white w-9 h-9 rounded-lg flex items-center justify-center">
                    {waitingForReply ? <Loader size={16} className="animate-spin" /> : <ArrowUp size={16} />}
                  </button>
                </form>
              </section>

              <SideDraftPanel draft={draft} confidence={confidence} onSwitchToForm={switchToStructuredForm} />
            </div>
          )}

          {view === 'review' && <ReviewView draft={draft} confidence={confidence} onEdit={editField} onBack={() => setView('chat')} onCreate={createProject} creating={creating} />}

          {view === 'success' && <SuccessView draft={draft} matchCounts={matchCounts} projectId={createdProjectId} />}
        </div>
      </main>
    </>
  );
}

// ── Review view ──────────────────────────────────────────────────────────

function ReviewRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="mb-5">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase">{label}</p>
        <button onClick={onEdit} className="text-[12px] font-medium text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">
          <Edit3 size={11} /> Edit
        </button>
      </div>
      <p className="text-sm text-white mt-1">{value}</p>
    </div>
  );
}

function ReviewView({ draft, confidence, onEdit, onBack, onCreate, creating }: {
  draft: ProjectDraft;
  confidence: Record<string, 'high' | 'medium' | 'low'>;
  onEdit: (label: string) => void;
  onBack: () => void;
  onCreate: () => void;
  creating: boolean;
}) {
  const notes: { lbl: string; val: string; conf: 'high' | 'medium' | 'low' }[] = [];
  if (draft.ntee_codes.length > 0) notes.push({ lbl: 'NTEE auto-classified', val: draft.ntee_codes.join(' + '), conf: confidence.ntee_codes || 'medium' });
  if (draft.mission) notes.push({ lbl: 'Mission summary', val: 'Paraphrased from your own words', conf: confidence.mission || 'high' });
  if (draft.funding_target != null) notes.push({ lbl: 'Funding target', val: 'Suggested from peer median', conf: confidence.funding_target || 'medium' });
  if (draft.geographic_scope) notes.push({ lbl: 'Geographic scope', val: 'Inferred from chat', conf: confidence.geographic_scope || 'high' });
  if (draft.timeline_start || draft.timeline_end) notes.push({ lbl: 'Timeline', val: 'Parsed from chat', conf: confidence.timeline_start || 'high' });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
      <section className="bg-[#161b22] border border-[#30363d] rounded-xl p-6 flex flex-col" style={{ minHeight: 560 }}>
        <h2 className="text-2xl font-semibold">{draft.name || 'Untitled project'}</h2>
        <p className="text-xs text-gray-400 mt-1">{draft.geographic_scope || '—'}{draft.tags.length > 0 ? `  ·  ${draft.tags.slice(0,2).join(' / ')}` : ''}</p>
        <div className="mt-6 flex-1">
          {draft.mission && <ReviewRow label="Mission summary" value={draft.mission} onEdit={() => onEdit('mission summary')} />}
          {draft.tags.length > 0 && <ReviewRow label="Tags" value={draft.tags.join(' · ')} onEdit={() => onEdit('tags')} />}
          {draft.funding_target != null && <ReviewRow label="Funding target" value={`${fmtCurrency(draft.funding_target)} / year`} onEdit={() => onEdit('funding target')} />}
          {(draft.timeline_start || draft.timeline_end) && <ReviewRow label="Timeline" value={timelineSummary(draft) || ''} onEdit={() => onEdit('timeline')} />}
          {draft.geographic_scope && <ReviewRow label="Geographic scope" value={draft.geographic_scope} onEdit={() => onEdit('geographic scope')} />}
        </div>
        <div className="flex flex-wrap gap-3 mt-4">
          <button onClick={onCreate} disabled={creating} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white rounded-lg text-sm font-semibold inline-flex items-center gap-2">
            {creating ? <><Loader size={14} className="animate-spin" /> Creating…</> : 'Create project & find funders'}
          </button>
          <button onClick={onBack} className="px-5 py-2.5 bg-[#0d1117] border border-[#30363d] hover:border-[#484f58] text-white rounded-lg text-sm font-medium inline-flex items-center gap-2">
            <ArrowLeft size={14} /> Back to chat
          </button>
        </div>
      </section>

      <aside className="bg-[#161b22] border border-[#30363d] rounded-xl p-5">
        <p className="text-sm font-semibold text-white">What the AI heard</p>
        <p className="text-[11px] text-gray-400 mb-3">Tap any field on the left to edit it in chat.</p>
        <div className="space-y-2">
          {notes.length === 0 && <p className="text-xs text-gray-400">No inferences yet.</p>}
          {notes.map(n => (
            <div key={n.lbl} className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${n.conf === 'high' ? 'bg-green-400' : n.conf === 'medium' ? 'bg-yellow-400' : 'bg-red-400'}`} />
                <p className="text-[11px] font-semibold text-white">{n.lbl}</p>
              </div>
              <p className="text-[11px] text-gray-400 mt-1 ml-4">{n.val}</p>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

// ── Success view ─────────────────────────────────────────────────────────

function SuccessView({ draft, matchCounts, projectId }: { draft: ProjectDraft; matchCounts: { total: number; highFit: number; closingSoon: number } | null; projectId: string | null }) {
  const navigate = useNavigate();
  const subtitle = [
    draft.name,
    draft.funding_target != null ? `${fmtCurrency(draft.funding_target)} / yr` : null,
    draft.geographic_scope,
  ].filter(Boolean).join('  ·  ');
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-10 max-w-xl w-full">
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 rounded-full bg-green-500 flex items-center justify-center">
            <Check size={32} className="text-white" />
          </div>
        </div>
        <h2 className="text-2xl font-semibold text-center">Project created</h2>
        {subtitle && <p className="text-center text-xs text-gray-400 mt-2">{subtitle}</p>}
        {matchCounts && (
          <div className="grid grid-cols-3 gap-3 mt-7">
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-4">
              <p className="text-2xl font-semibold">{matchCounts.total}</p>
              <p className="text-[11px] text-gray-400 mt-1">Matched funders</p>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-4">
              <p className="text-2xl font-semibold">{matchCounts.highFit}</p>
              <p className="text-[11px] text-gray-400 mt-1">High-fit matches</p>
            </div>
            <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-4">
              <p className="text-2xl font-semibold">{matchCounts.closingSoon}</p>
              <p className="text-[11px] text-gray-400 mt-1">Closing in 30 days</p>
            </div>
          </div>
        )}
        <div className="flex gap-3 mt-7">
          <button onClick={() => projectId && navigate(`/projects/${projectId}/matches`)} disabled={!projectId}
            className="flex-1 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-semibold inline-flex items-center justify-center gap-2">
            See funder matches →
          </button>
          <button onClick={() => navigate('/dashboard')}
            className="px-5 py-2.5 bg-[#0d1117] border border-[#30363d] hover:border-[#484f58] text-white rounded-lg text-sm font-medium">
            Back to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
