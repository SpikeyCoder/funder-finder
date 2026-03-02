import { useEffect, useState } from 'react';
import { Bookmark, BookmarkCheck, PenLine, Wand2, CheckCircle2 } from 'lucide-react';

/**
 * DemoVideo – CSS/React animated product demo for the Landing page.
 *
 * 5-step cycle (~9 s total):
 *   0: Results page — user saves a funder  (0–1.8 s)
 *   1: Saved Funders page — list appears   (1.8–3.6 s)
 *   2: Click "Write Grant"                 (3.6–5.0 s)
 *   3: AI generates draft (streaming)      (5.0–7.2 s)
 *   4: Score & completion shown            (7.2–9.0 s)
 *   → loops back to step 0
 */

const STEP_DURATION = [1800, 1800, 1400, 2200, 1800]; // ms per step
const TOTAL = STEP_DURATION.reduce((a, b) => a + b, 0);

const STREAMING_LINES = [
  '## 📊 Funder-Fit Summary',
  'Strong alignment with youth education focus areas...',
  '## ✅ Compliance Checklist',
  '✓ 501(c)(3) status required',
  '✓ Geographic match: Northeast US',
  '## 📝 Grant Application Draft',
  '### 1. Executive Summary',
  'The Community Youth Alliance requests $50,000...',
];

export default function DemoVideo() {
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState(false);
  const [streamIdx, setStreamIdx] = useState(0);
  const [score, setScore] = useState(0);

  // Advance steps on a timer
  useEffect(() => {
    let elapsed = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const schedule = (s: number, delay: number) => {
      timers.push(
        setTimeout(() => {
          setStep(s);
          if (s === 0) { setSaved(false); setStreamIdx(0); setScore(0); }
          if (s === 1) { setSaved(true); }
          if (s === 3) { setStreamIdx(0); }
        }, delay),
      );
    };

    schedule(0, 0);
    elapsed += STEP_DURATION[0];
    schedule(1, elapsed);
    elapsed += STEP_DURATION[1];
    schedule(2, elapsed);
    elapsed += STEP_DURATION[2];
    schedule(3, elapsed);
    elapsed += STEP_DURATION[3];
    schedule(4, elapsed);
    elapsed += STEP_DURATION[4];

    // Loop
    const loop = setInterval(() => {
      setStep(0);
      setSaved(false);
      setStreamIdx(0);
      setScore(0);
      let e = 0;
      STEP_DURATION.forEach((dur, i) => {
        timers.push(setTimeout(() => {
          setStep(i);
          if (i === 1) setSaved(true);
          if (i === 3) setStreamIdx(0);
        }, e));
        e += dur;
      });
    }, TOTAL);

    return () => {
      timers.forEach(clearTimeout);
      clearInterval(loop);
    };
  }, []);

  // Stream text line-by-line during step 3
  useEffect(() => {
    if (step !== 3) return;
    if (streamIdx >= STREAMING_LINES.length) return;
    const t = setTimeout(() => setStreamIdx(i => i + 1), 260);
    return () => clearTimeout(t);
  }, [step, streamIdx]);

  // Animate score counter during step 4
  useEffect(() => {
    if (step !== 4) return;
    let v = 0;
    const t = setInterval(() => {
      v += 3;
      if (v >= 87) { setScore(87); clearInterval(t); }
      else setScore(v);
    }, 25);
    return () => clearInterval(t);
  }, [step]);

  return (
    <div className="w-full flex justify-center px-4 py-8">
      {/* Outer wrapper — max width, aspect ratio preserved */}
      <div className="w-full max-w-2xl">
        {/* Browser chrome mock */}
        <div className="rounded-2xl overflow-hidden border border-[#30363d] shadow-2xl shadow-black/50">
          {/* Browser bar */}
          <div className="bg-[#161b22] border-b border-[#30363d] px-4 py-3 flex items-center gap-3">
            <div className="flex gap-1.5">
              <span className="w-3 h-3 rounded-full bg-red-500/70" />
              <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
              <span className="w-3 h-3 rounded-full bg-green-500/70" />
            </div>
            <div className="flex-1 bg-[#0d1117] rounded-md px-3 py-1 text-xs text-gray-400 truncate">
              funder-finder.app
            </div>
          </div>

          {/* Screen content */}
          <div className="bg-[#0d1117] h-72 sm:h-80 relative overflow-hidden">

            {/* ── Step 0: Results card with Save button ── */}
            <ScreenSlide visible={step === 0}>
              <div className="p-5 space-y-3">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Funder Matches</p>
                <FunderCard
                  name="Gates Foundation"
                  type="foundation · National"
                  score={92}
                  saved={saved}
                  onSave={() => setSaved(true)}
                  highlight={!saved}
                />
                <FunderCard name="Knight Foundation" type="foundation · Miami, FL" score={78} saved={false} />
              </div>
            </ScreenSlide>

            {/* ── Step 1: Saved Funders list ── */}
            <ScreenSlide visible={step === 1}>
              <div className="p-5 space-y-3">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Saved Funders</p>
                <SavedCard name="Gates Foundation" status="researching" showWriteButton={false} />
                <SavedCard name="Knight Foundation" status="applied" showWriteButton={false} />
              </div>
            </ScreenSlide>

            {/* ── Step 2: Write Grant highlighted ── */}
            <ScreenSlide visible={step === 2}>
              <div className="p-5 space-y-3">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Saved Funders</p>
                <SavedCard name="Gates Foundation" status="researching" showWriteButton highlight />
                <SavedCard name="Knight Foundation" status="applied" showWriteButton={false} />
              </div>
            </ScreenSlide>

            {/* ── Step 3: AI streaming output ── */}
            <ScreenSlide visible={step === 3}>
              <div className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Wand2 size={14} className="text-blue-400" />
                  <p className="text-sm font-semibold">AI Grant Writer</p>
                  <span className="ml-auto flex gap-1 items-center text-xs text-blue-400">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    Generating…
                  </span>
                </div>
                <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-3 space-y-1 text-xs font-mono">
                  {STREAMING_LINES.slice(0, streamIdx).map((line, i) => (
                    <p
                      key={i}
                      className={
                        line.startsWith('##')
                          ? 'text-blue-400 font-bold'
                          : line.startsWith('✓')
                          ? 'text-green-400'
                          : line.startsWith('###')
                          ? 'text-white font-semibold'
                          : 'text-gray-300'
                      }
                    >
                      {line}
                    </p>
                  ))}
                  {streamIdx < STREAMING_LINES.length && (
                    <span className="inline-block w-1.5 h-3 bg-blue-400 animate-pulse rounded-sm" />
                  )}
                </div>
              </div>
            </ScreenSlide>

            {/* ── Step 4: Score + done ── */}
            <ScreenSlide visible={step === 4}>
              <div className="p-5 flex flex-col items-center justify-center h-full gap-4">
                <div className="flex items-center gap-3">
                  <CheckCircle2 size={28} className="text-green-400" />
                  <p className="text-lg font-bold">Grant Draft Ready</p>
                </div>
                <div className="bg-[#161b22] border border-[#30363d] rounded-2xl px-8 py-4 text-center">
                  <p className="text-xs text-gray-400 mb-1">Funder-Fit Score</p>
                  <p
                    className="text-5xl font-bold tabular-nums"
                    style={{
                      color: score >= 80 ? '#4ade80' : score >= 60 ? '#60a5fa' : '#9ca3af',
                    }}
                  >
                    {score}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">/ 100</p>
                </div>
                <p className="text-xs text-gray-400 text-center max-w-xs">
                  Complete 8-section narrative · Compliance checklist · Personalized to Gates Foundation
                </p>
              </div>
            </ScreenSlide>

          </div>

          {/* Progress bar */}
          <div className="h-0.5 bg-[#21262d]">
            <ProgressBar step={step} />
          </div>
        </div>

        {/* Step labels */}
        <div className="flex justify-between mt-3 px-1">
          {['Save Funder', 'My Pipeline', 'Write Grant', 'AI Generates', 'Done ✓'].map((label, i) => (
            <span
              key={label}
              className={`text-xs transition-colors duration-300 ${
                step === i ? 'text-blue-400 font-semibold' : 'text-gray-500'
              }`}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScreenSlide({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <div
      className="absolute inset-0 transition-opacity duration-500"
      style={{ opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none' }}
    >
      {children}
    </div>
  );
}

function FunderCard({
  name,
  type,
  score,
  saved,
  onSave,
  highlight,
}: {
  name: string;
  type: string;
  score: number;
  saved?: boolean;
  onSave?: () => void;
  highlight?: boolean;
}) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="font-semibold text-sm truncate">{name}</p>
        <p className="text-xs text-gray-400">{type}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-green-400 font-semibold">{score}%</span>
        <button
          onClick={onSave}
          className={`flex items-center gap-1 border rounded-lg px-2.5 py-1 text-xs transition-all duration-300 ${
            saved
              ? 'border-blue-600 text-blue-400 bg-blue-900/20'
              : highlight
              ? 'border-white text-white bg-white/10 animate-pulse'
              : 'border-[#30363d] text-gray-300'
          }`}
        >
          {saved ? <BookmarkCheck size={12} /> : <Bookmark size={12} />}
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function SavedCard({
  name,
  status,
  showWriteButton,
  highlight,
}: {
  name: string;
  status: string;
  showWriteButton: boolean;
  highlight?: boolean;
}) {
  const statusColors: Record<string, string> = {
    researching: 'text-blue-300 bg-blue-900/30 border-blue-700',
    applied: 'text-amber-300 bg-amber-900/30 border-amber-700',
  };
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-4 py-3 flex items-center justify-between gap-3">
      <div className="min-w-0 flex items-center gap-2">
        <p className="font-semibold text-sm truncate">{name}</p>
        <span className={`text-xs border px-2 py-0.5 rounded-full ${statusColors[status] || 'text-gray-400 border-gray-600'}`}>
          {status}
        </span>
      </div>
      {showWriteButton && (
        <button
          className={`flex items-center gap-1 border rounded-lg px-2.5 py-1 text-xs shrink-0 transition-all duration-300 ${
            highlight
              ? 'border-purple-500 text-purple-300 bg-purple-900/30 scale-105 shadow-lg shadow-purple-900/30'
              : 'border-purple-700 text-purple-400'
          }`}
        >
          <PenLine size={11} />
          Write Grant
        </button>
      )}
    </div>
  );
}

function ProgressBar({ step }: { step: number }) {
  // Each step occupies an equal slice; fill up to current step
  const pct = ((step + 1) / 5) * 100;
  return (
    <div
      className="h-full bg-blue-500 transition-all duration-700 ease-in-out"
      style={{ width: `${pct}%` }}
    />
  );
}
