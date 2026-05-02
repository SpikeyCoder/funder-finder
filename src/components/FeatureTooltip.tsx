import { useState, useEffect } from 'react';
import { X } from 'lucide-react';

interface TooltipConfig {
  id: string;
  target: string;
  title: string;
  description: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

const TOOLTIPS: TooltipConfig[] = [
  { id: 'tracker', target: '[data-tooltip="tracker"]', title: 'Grant Tracker', description: 'Track your grant applications through every pipeline stage. Click any grant to see details and manage tasks.', position: 'bottom' },
  { id: 'calendar', target: '[data-tooltip="calendar"]', title: 'Deadline Calendar', description: 'View all grant deadlines in a monthly calendar. Never miss an important date.', position: 'bottom' },
  { id: 'reports', target: '[data-tooltip="reports"]', title: 'Portfolio Reports', description: 'See your grant performance at a glance - win rates, pipeline status, and funding trends.', position: 'bottom' },
  { id: 'ai-draft', target: '[data-tooltip="ai-draft"]', title: 'AI Draft Assistant', description: 'Generate grant proposal drafts powered by AI. Build your knowledge base for better results.', position: 'bottom' },
];

// Once the tour has been shown to a user, we never want to re-trigger it -
// either within the same browser session or for a logged-in user across
// sessions. We persist a single "seen" flag in localStorage which is set
// the first time any tooltip appears.
const SEEN_FLAG_KEY = 'fm_tooltips_seen';

export default function FeatureTooltips() {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // If the tour has already been displayed once on this device/profile,
    // do not show it again. This satisfies the "show once per browser
    // session or for a logged-in user" requirement.
    if (localStorage.getItem(SEEN_FLAG_KEY) === 'true') return;

    const stored = localStorage.getItem('fm_tooltips_dismissed');
    if (stored) {
      const parsed = JSON.parse(stored);
      setDismissed(parsed);
      if (parsed.length >= TOOLTIPS.length) return; // All dismissed previously
    }

    // Check if within first 7 days
    const firstSeen = localStorage.getItem('fm_first_seen');
    if (!firstSeen) {
      localStorage.setItem('fm_first_seen', new Date().toISOString());
    } else {
      const daysSince = (Date.now() - new Date(firstSeen).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 7) return; // Past 7 days
    }

    // Show first undismissed tooltip after delay
    const timer = setTimeout(() => {
      const stored2 = JSON.parse(localStorage.getItem('fm_tooltips_dismissed') || '[]');
      const next = TOOLTIPS.find(t => !stored2.includes(t.id));
      if (next) {
        setActive(next.id);
        setVisible(true);
        // Mark the tour as seen so it never re-triggers in a future
        // session, even if the user closes the browser before stepping
        // through every tooltip.
        localStorage.setItem(SEEN_FLAG_KEY, 'true');
      }
    }, 2000);

    return () => clearTimeout(timer);
  }, []);

  const dismiss = (id: string) => {
    const updated = [...dismissed, id];
    setDismissed(updated);
    localStorage.setItem('fm_tooltips_dismissed', JSON.stringify(updated));
    setVisible(false);

    // Show next tooltip after a delay
    setTimeout(() => {
      const next = TOOLTIPS.find(t => !updated.includes(t.id));
      if (next) {
        setActive(next.id);
        setVisible(true);
      }
    }, 500);
  };

  if (!visible || !active) return null;
  const tooltip = TOOLTIPS.find(t => t.id === active);
  if (!tooltip) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 max-w-xs bg-blue-600 text-white rounded-lg shadow-2xl p-4 animate-fade-in">
      <button onClick={() => dismiss(tooltip.id)} aria-label="Dismiss tooltip" className="absolute top-2 right-2 text-white/70 hover:text-white">
        <X size={14} aria-hidden="true" />
      </button>
      <p className="text-sm font-semibold mb-1">{tooltip.title}</p>
      <p className="text-xs text-blue-100 leading-relaxed">{tooltip.description}</p>
      <div className="flex items-center justify-between mt-3">
        <span className="text-[10px] text-blue-200">
          {TOOLTIPS.findIndex(t => t.id === tooltip.id) + 1} of {TOOLTIPS.length}
        </span>
        <button onClick={() => dismiss(tooltip.id)}
          className="text-xs font-medium px-2 py-1 bg-white/20 hover:bg-white/30 rounded transition-colors">
          Got it
        </button>
      </div>
    </div>
  );
}
