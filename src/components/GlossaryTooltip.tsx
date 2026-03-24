import { useState, useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';

const GLOSSARY: Record<string, string> = {
  DAF: 'Donor-Advised Fund \u2014 a charitable giving account managed by a sponsoring organization. Donors contribute to the fund, receive an immediate tax deduction, and recommend grants over time.',
  NTEE: 'National Taxonomy of Exempt Entities \u2014 a classification system used by the IRS and nonprofit sector to categorize organizations by their primary purpose (e.g., B20 = Elementary/Secondary Education).',
  '990': 'IRS Form 990 \u2014 an annual information return that tax-exempt organizations must file with the IRS, disclosing finances, governance, and activities. Form 990-PF is specifically for private foundations.',
  'peer nonprofits': 'Organizations similar to yours in mission, size, or geography. FunderMatch uses peer data to identify funders that have supported nonprofits like yours.',
  'fit score': 'A percentage indicating how well a funder aligns with your mission, location, budget, and focus areas. Higher scores mean stronger alignment based on AI analysis of the funder\'s giving history.',
};

interface GlossaryTooltipProps {
  term: string;
  className?: string;
}

export default function GlossaryTooltip({ term, className = '' }: GlossaryTooltipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const definition = GLOSSARY[term];
  if (!definition) return null;

  return (
    <span ref={ref} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="inline-flex items-center gap-0.5 text-gray-400 hover:text-blue-400 transition-colors"
        aria-label={`What is ${term}?`}
      >
        <HelpCircle size={13} />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 bg-[#21262d] border border-[#30363d] text-gray-200 text-xs leading-relaxed rounded-lg px-3 py-2 shadow-xl z-50 pointer-events-none"
        >
          <strong className="text-white">{term}:</strong> {definition}
        </span>
      )}
    </span>
  );
}
