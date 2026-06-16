import { useState, useEffect, useCallback, useRef } from 'react';
import { X, ArrowLeft, ArrowRight } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

/**
 * FM-IC-ONB-002 — Interactive guided product tour ("live walkthrough").
 *
 * The 2026-06-11 usability audit rated onboarding PARTIAL: in-app hints
 * (FeatureTooltip / GlossaryTooltip) and the OnboardingPage checklist exist,
 * but there was no cohesive, re-launchable step-by-step walkthrough of the
 * actual product — the kind of guided tour Instrumentl offers new users.
 *
 * This is a self-contained, dependency-free spotlight tour. Each step can
 * point at a real UI element via a [data-tour="..."] anchor; when the anchor
 * is on screen it is highlighted with a spotlight cutout and the explanation
 * card is anchored to it, otherwise the card is centered. The tour:
 *   - auto-launches once for signed-in users (localStorage flag), and
 *   - can be re-launched anytime by dispatching `window` event `fm:start-tour`
 *     (e.g. a "Take the tour" button on the onboarding page or a help menu).
 */

interface TourStep {
  id: string;
  target?: string; // CSS selector for the element to spotlight
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to FunderMatch',
    body: "Here's a 60-second tour of how to go from finding funders to tracking awards. You can skip anytime and restart it later from the onboarding page.",
  },
  {
    id: 'find-funders',
    target: '[data-tour="find-funders"]',
    title: 'Find funders',
    body: 'Describe your mission and FunderMatch returns AI-matched foundations, corporate, government and DAF funders ranked to your work.',
  },
  {
    id: 'browse',
    target: '[data-tour="browse"]',
    title: 'Browse the grant database',
    body: 'Explore the full grant database without setting up a project — filter by location, field of work, funding type and deadline.',
  },
  {
    id: 'dashboard',
    target: '[data-tour="dashboard"]',
    title: 'Organize work into projects',
    body: 'Create a project per funding initiative. Each project keeps its own matches, pipeline, peers and deadlines separate.',
  },
  {
    id: 'tasks',
    target: '[data-tour="tasks"]',
    title: 'Stay on top of tasks',
    body: 'Assign tasks to teammates and track everything due across all your projects in one place.',
  },
  {
    id: 'reports',
    title: 'Reports & post-award compliance',
    body: 'The Reports page shows portfolio performance and post-award compliance — reporting deadlines, deliverables and submission status — so nothing slips after the award.',
  },
  {
    id: 'finish',
    title: "You're all set",
    body: 'Save a funder to your pipeline to get started. You can re-open this tour anytime from the onboarding page.',
  },
];

const SEEN_KEY = 'fm_product_tour_seen';

export default function ProductTour() {
  const { user, loading } = useAuth();
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const start = useCallback(() => {
    setStep(0);
    setActive(true);
  }, []);

  const finish = useCallback(() => {
    setActive(false);
    setRect(null);
    try {
      localStorage.setItem(SEEN_KEY, 'true');
    } catch {
      /* ignore storage failures (private mode) */
    }
  }, []);

  // Re-launch hook: any "Take the tour" control can dispatch this event.
  useEffect(() => {
    const handler = () => start();
    window.addEventListener('fm:start-tour', handler);
    return () => window.removeEventListener('fm:start-tour', handler);
  }, [start]);

  // Auto-launch once for signed-in users.
  useEffect(() => {
    if (loading || !user || active) return;
    let seen = false;
    try {
      seen = localStorage.getItem(SEEN_KEY) === 'true';
    } catch {
      seen = false;
    }
    if (seen) return;
    const t = setTimeout(() => start(), 1200);
    return () => clearTimeout(t);
  }, [loading, user, active, start]);

  // Measure the current step's target (if any) and keep it in sync.
  useEffect(() => {
    if (!active) return;
    const current = STEPS[step];
    const measure = () => {
      if (!current?.target) {
        setRect(null);
        return;
      }
      const el = document.querySelector(current.target) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setRect(el.getBoundingClientRect());
      } else {
        setRect(null);
      }
    };
    measure();
    const onChange = () => measure();
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [active, step]);

  // Keyboard: Esc to skip, arrows to navigate.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(s + 1, STEPS.length - 1));
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(s - 1, 0));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, finish]);

  if (!active) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const pad = 8;

  // Card placement: below the target if there's room, otherwise centered.
  let cardStyle: React.CSSProperties = {
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
  };
  if (rect) {
    const below = rect.bottom + 12;
    const placeBelow = below + 200 < window.innerHeight;
    const left = Math.min(Math.max(rect.left, 12), window.innerWidth - 340);
    cardStyle = placeBelow
      ? { top: below, left }
      : { top: Math.max(rect.top - 12, 12), left, transform: 'translateY(-100%)' };
  }

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Product tour">
      {/* Dimmed backdrop with a spotlight cutout around the target (or full dim). */}
      {rect ? (
        <div
          aria-hidden="true"
          className="absolute rounded-lg transition-all duration-200 pointer-events-none"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: '0 0 0 9999px rgba(2,6,15,0.72)',
          }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-[#02060f]/70" />
      )}

      {/* Click-catcher so backdrop clicks don't hit the app underneath. */}
      <div className="absolute inset-0" onClick={finish} />

      {/* Explanation card */}
      <div
        ref={tipRef}
        className="absolute w-[320px] max-w-[calc(100vw-24px)] bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl p-5"
        style={cardStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={finish}
          aria-label="Close tour"
          className="absolute top-3 right-3 text-gray-500 hover:text-white transition-colors"
        >
          <X size={16} aria-hidden="true" />
        </button>
        <p className="text-xs font-medium text-blue-400 mb-1">
          Step {step + 1} of {STEPS.length}
        </p>
        <h3 className="text-base font-semibold text-white mb-1.5">{current.title}</h3>
        <p className="text-sm text-gray-300 leading-relaxed">{current.body}</p>

        <div className="flex items-center gap-1.5 mt-4 mb-3" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? 'w-5 bg-blue-500' : 'w-1.5 bg-[#30363d]'
              }`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={finish}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => Math.max(s - 1, 0))}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-300 hover:text-white bg-white/[0.04] hover:bg-white/[0.08] rounded-lg transition-colors"
              >
                <ArrowLeft size={13} aria-hidden="true" /> Back
              </button>
            )}
            <button
              onClick={() => (isLast ? finish() : setStep((s) => Math.min(s + 1, STEPS.length - 1)))}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              {isLast ? 'Got it' : 'Next'}
              {!isLast && <ArrowRight size={13} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
