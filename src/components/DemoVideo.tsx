import { useEffect, useState } from 'react';
import { Bookmark, BookmarkCheck, PenLine, Wand2, CheckCircle2, Search, MapPin } from 'lucide-react';

/**
 * DemoVideo – CSS/React animated product demo for the Landing page.
 *
 * 8-step cycle (20.0 s total):
 *   0: Landing — "Get Started" button pulses then clicks     (0–2.0 s)
 *   1: Mission Input — typing mission + location             (2.0–7.0 s)
 *   2: Form complete — "Find Matching Funders" button click  (7.0–8.5 s)
 *   3: Results page — user saves a funder                   (8.5–10.5 s)
 *   4: Saved Funders list appears                           (10.5–12.5 s)
 *   5: Click "Write Grant" highlighted                      (12.5–14.0 s)
 *   6: AI generates draft (streaming)                       (14.0–17.0 s)
 *   7: Score & completion shown                             (17.0–20.0 s)
 *   → loops back to step 0
 */

const STEP_DURATION = [2000, 5000, 1500, 2000, 2000, 1500, 3000, 3000]; // ms — total: 20 000 ms
const TOTAL = STEP_DURATION.reduce((a, b) => a + b, 0); // 20 000

const MISSION_TEXT = 'Provide after-school STEM programs for middle school students';
const LOCATION_TEXT = 'Chicago, IL';

// Typing speeds (ms per character)
const MISSION_CHAR_MS = 55;   // 61 chars × 55 ms ≈ 3 355 ms
const LOCATION_PAUSE_MS = 300; // pause after mission before location
const LOCATION_CHAR_MS = 80;  // 11 chars × 80 ms = 880 ms

const STREAMING_LINES = [
  '## 📊 Funder-Fit Summary',
  'Strong alignment with youth education focus areas...',
  '## + Compliance Checklist',
  '+ 501(c)(3) status required',
  '+ Geographic match: Chicago, IL',
  '## 📝 Grant Application Draft',
  '### 1. Executive Summary',
  'The Community Youth Alliance requests $50,000...',
];

const STEP_LABELS = ['Start', 'Mission', 'Search', 'Save', 'Pipeline', 'Write Grant', 'Generating', 'Done +'];

export default function DemoVideo() {
  const [step, setStep] = useState(0);
  const [getStartedClicked, setGetStartedClicked] = useState(false);
  const [missionChars, setMissionChars] = useState(0);
  const [locationChars, setLocationChars] = useState(0);
  const [searchClicked, setSearchClicked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [streamIdx, setStreamIdx] = useState(0);
  const [score, setScore] = useState(0);

  // Advance steps on a timer
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    const scheduleSteps = () => {
      let elapsed = 0;

      // ── Step 0: Landing ──────────────────────────────────────────
      timers.push(
        setTimeout(() => {
          setStep(0);
          setGetStartedClicked(false);
          setMissionChars(0);
          setLocationChars(0);
          setSearchClicked(false);
          setSaved(false);
          setStreamIdx(0);
          setScore(0);
        }, elapsed),
      );
      // Animate the button click 1 200 ms into step 0
      timers.push(setTimeout(() => setGetStartedClicked(true), elapsed + 1200));
      elapsed += STEP_DURATION[0];

      // ── Step 1: Mission input (typing) ─────────────────────────
      timers.push(
        setTimeout(() => {
          setStep(1);
          setMissionChars(0);
          setLocationChars(0);
        }, elapsed),
      );
      elapsed += STEP_DURATION[1];

      // ── Step 2: Form submit ────────────────────────────────────
      timers.push(setTimeout(() => { setStep(2); setSearchClicked(false); }, elapsed));
      timers.push(setTimeout(() => setSearchClicked(true), elapsed + 700));
      elapsed += STEP_DURATION[2];

      // ── Step 3: Results ────────────────────────────────────────
      timers.push(setTimeout(() => { setStep(3); setSaved(false); }, elapsed));
      elapsed += STEP_DURATION[3];

      // ── Step 4: Saved Funders list ─────────────────────────────
      timers.push(setTimeout(() => { setStep(4); setSaved(true); }, elapsed));
      elapsed += STEP_DURATION[4];

      // ── Step 5: Write Grant highlighted ────────────────────────
      timers.push(setTimeout(() => setStep(5), elapsed));
      elapsed += STEP_DURATION[5];

      // ── Step 6: AI streaming ──────────────────────────────────
      timers.push(setTimeout(() => { setStep(6); setStreamIdx(0); }, elapsed));
      elapsed += STEP_DURATION[6];

      // ── Step 7: Score + done ──────────────────────────────────
      timers.push(setTimeout(() => setStep(7), elapsed));
    };

    scheduleSteps();
    const loop = setInterval(scheduleSteps, TOTAL);

    return () => {
      timers.forEach(clearTimeout);
      clearInterval(loop);
    };
  }, []);

  // Mission typing during step 1
  useEffect(() => {
    if (step !== 1) return;
    if (missionChars >= MISSION_TEXT.length) return;
    const t = setTimeout(() => setMissionChars(c => c + 1), MISSION_CHAR_MS);
    return () => clearTimeout(t);
  }, [step, missionChars]);

  // Location typing during step 1, after mission is done
  useEffect(() => {
    if (step !== 1) return;
    if (missionChars < MISSION_TEXT.length) return;
    if (locationChars >= LOCATION_TEXT.length) return;
    const delay = locationChars === 0 ? LOCATION_PAUSE_MS : LOCATION_CHAR_MS;
    const t = setTimeout(() => setLocationChars(c => c + 1), delay);
    return () => clearTimeout(t);
  }, [step, missionChars, locationChars]);

  // Stream text line-by-line during step 6
  useEffect(() => {
    if (step !== 6) return;
    if (streamIdx >= STREAMING_LINES.length) return;
    const t = setTimeout(() => setStreamIdx(i => i + 1), 350);
    return () => clearTimeout(t);
  }, [step, streamIdx]);

  // Animate score counter during step 7
  useEffect(() => {
    if (step !== 7) return;
    let v = 0;
    const t = setInterval(() => {
      v += 3;
      if (v >= 87) { setScore(87); clearInterval(t); }
      else setScore(v);
    }, 25);
    return () => clearInterval(t);
  }, [step]);

  const missionDone = missionChars >= MISSION_TEXT.length;
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
              fundermatch.org
            </div>
          </div>

          {/* Screen content */}
          <div className="bg-[#0d1117] h-72 sm:h-80 relative overflow-hidden">

            {/* ── Step 0: Landing page with Get Started ── */}
            <ScreenSlide visible={step === 0}>
              <div className="flex flex-col items-center justify-center h-full px-6 sm:px-8 text-center bg-gradient-to-b from-[#020916] via-[#030913] to-[#020712]">
                <h2 className="text-[30px] sm:text-[44px] font-bold leading-[1.08] tracking-[-0.02em] text-white max-w-[760px]">
                  Find Funders Aligned to Your
                  <br />
                  Mission
                </h2>
                <p className="mt-5 text-[15px] sm:text-[18px] leading-relaxed text-gray-400 max-w-[680px]">
                  Connect with foundations, DAFs, and corporate giving programs
                  that match your nonprofit's mission in seconds.
                </p>
                <button
                  className={`mt-6 inline-flex items-center gap-3 rounded-2xl px-7 sm:px-9 py-3 sm:py-4 text-lg font-semibold border transition-all duration-300 ${
                    getStartedClicked
                      ? 'bg-gray-200 text-gray-900 scale-95 opacity-80 border-white/20'
                      : 'bg-white text-gray-900 border-white shadow-[0_12px_30px_rgba(255,255,255,0.14)] animate-pulse'
                  }`}
                >
                  <Search size={20} className="shrink-0" />
                  Get Started
                </button>
                <p className="mt-5 text-sm sm:text-base text-gray-400">
                  No account required &middot; No credit card &middot; Results in 30 seconds
                </p>
              </div>
            </ScreenSlide>

            {/* ── Step 1: Mission input form, typing ── */}
            <ScreenSlide visible={step === 1}>
              <div className="p-5 space-y-3">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Tell us about your mission</p>

                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-semibold">Your Mission Statement <span className="text-red-400">*</span></label>
                  <div className="bg-[#161b22] border border-blue-700/60 rounded-xl px-3 py-2 text-sm leading-snug min-h-[56px]">
                    {MISSION_TEXT.slice(0, missionChars)}
                    {!missionDone && (
                      <span className="inline-block w-0.5 h-3.5 bg-blue-400 animate-pulse ml-px align-middle" />
                    )}
                  </div>
                </div>

                <div className="space-y-1 relative">
                  <label className="text-xs text-gray-400 font-semibold flex items-center gap-1">
                    <MapPin size={11} /> Location Served <span className="text-red-400">*</span>
                  </label>
                  <div className={`bg-[#161b22] border rounded-xl px-3 py-2 text-sm transition-colors duration-300 ${
                    missionDone ? 'border-blue-700/60' : 'border-[#30363d]'
                  }`}>
                    {locationChars > 0
                      ? LOCATION_TEXT.slice(0, locationChars)
                      : <span className="text-gray-600">e.g. King County, WA · Chicago, IL · National</span>
                    }
                    {missionDone && locationChars < LOCATION_TEXT.length && (
                      <span className="inline-block w-0.5 h-3.5 bg-blue-400 animate-pulse ml-px align-middle" />
                    )}
                  </div>
                  {/* Autocomplete dropdown hint — visible while typing location */}
                  {missionDone && locationChars > 0 && locationChars < LOCATION_TEXT.length && (
                    <div className="absolute left-0 right-0 top-full mt-1 bg-[#161b22] border border-[#30363d] rounded-xl overflow-hidden shadow-lg z-10">
                      <div className="px-3 py-1.5 text-xs text-white bg-blue-900/30 flex items-center gap-1.5">
                        <MapPin size={10} className="text-blue-400" /> Chicago, IL
                      </div>
                      <div className="px-3 py-1.5 text-xs text-gray-400">Chicago Heights, IL</div>
                    </div>
                  )}
                </div>
              </div>
            </ScreenSlide>
            {/* ── Step 2: Form complete + Find Matching Funders ── */}
            <ScreenSlide visible={step === 2}>
              <div className="p-5 space-y-3">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Tell us about your mission</p>

                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-semibold">Your Mission Statement <span className="text-red-400">*</span></label>
                  <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2 text-sm leading-snug">
                    {MISSION_TEXT}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-semibold flex items-center gap-1">
                    <MapPin size={11} /> Location Served <span className="text-red-400">*</span>
                  </label>
                  <div className="bg-[#161b22] border border-[#30363d] rounded-xl px-3 py-2 text-sm">
                    {LOCATION_TEXT}
                  </div>
                </div>

                <button
                  className={`w-full py-2 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all duration-300 ${
                    searchClicked
                      ? 'bg-blue-700 scale-95 text-white opacity-70'
                      : 'bg-blue-600 text-white'
                  }`}
                >
                  <Search size={14} />
                  Find Matching Funders
                </button>
              </div>
            </ScreenSlide>

            {/* ── Step 3: Results card with Save button ── */}
            <ScreenSlide visible={step === 3}>
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

            {/* ── Step 4: Saved Funders list ── */}
            <ScreenSlide visible={step === 4}>
              <div className="p-5 space-y-3">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Saved Funders</p>
                <SavedCard name="Gates Foundation" status="researching" showWriteButton={false} />
                <SavedCard name="Knight Foundation" status="applied" showWriteButton={false} />
              </div>
            </ScreenSlide>

            {/* ── Step 5: Write Grant highlighted ── */}
            <ScreenSlide visible={step === 5}>
              <div className="p-5 space-y-3">
                <p className="text-xs text-gray-400 font-medium uppercase tracking-wider">Saved Funders</p>
                <SavedCard name="Gates Foundation" status="researching" showWriteButton highlight />
                <SavedCard name="Knight Foundation" status="applied" showWriteButton={false} />
              </div>
            </ScreenSlide>

            {/* ── Step 6: AI streaming output ── */}
            <ScreenSlide visible={step === 6}>
              <div className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Wand2 size={14} className="text-blue-400" />
                  <p className="text-sm font-semibold">AI Grant Writer</p>
                  <span className="ml-auto flex gap-1 items-center text-xs text-blue-400">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    Generating...
                  </span>
                </div>
                <div className="bg-[#161b22] border border-[#30363d] rounded-xl p-3 space-y-1 text-xs font-mono">
                  {STREAMING_LINES.slice(0, streamIdx).map((line, i) => (
                    <p
                      key={i}
                      className={
                        line.startsWith('##')
                          ? 'text-blue-400 font-bold'
                          : line.startsWith('+')
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
            {/* ── Step 7: Score + done ── */}
            <ScreenSlide visible={step === 7}>
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
            <ProgressBar step={step} total={STEP_LABELS.length} />
          </div>
        </div>

        {/* Step labels */}
        <div className="flex justify-between mt-3 px-1">
          {STEP_LABELS.map((label, i) => (
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

// ── Sub-components ──────────────────────────────────────────────────────────

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

function ProgressBar({ step, total }: { step: number; total: number }) {
  const pct = ((step + 1) / total) * 100;
  return (
    <div
      className="h-full bg-blue-500 transition-all duration-700 ease-in-out"
      style={{ width: `${pct}%` }}
    />
  );
}
