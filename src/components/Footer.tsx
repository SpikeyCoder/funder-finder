import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="w-full border-t border-[#1b2130] bg-[#0d1117] py-8 px-6 mt-auto">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs text-gray-400">&copy; {new Date().getFullYear()} Armstrong HoldCo LLC. All rights reserved.</p>
        {/* Footer nav: links wrapped with inline-flex + min-h-[44px] so the
            tap area meets WCAG 2.5.5 / 44x44px touch-target spec on mobile,
            without enlarging the visible text. P3 fix, audit 2026-05-14. */}
        <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-2 sm:gap-4">
          <Link
            to="/docs/api"
            className="inline-flex items-center min-h-[44px] px-2 text-xs text-gray-400 hover:text-white transition-colors"
          >
            API Docs
          </Link>
          <Link
            to="/contact"
            className="inline-flex items-center min-h-[44px] px-2 text-xs text-gray-400 hover:text-white transition-colors"
          >
            Contact
          </Link>
          <Link
            to="/privacy"
            className="inline-flex items-center min-h-[44px] px-2 text-xs text-gray-400 hover:text-white transition-colors"
          >
            Privacy Policy
          </Link>
          <Link
            to="/terms"
            className="inline-flex items-center min-h-[44px] px-2 text-xs text-gray-400 hover:text-white transition-colors"
          >
            Terms of Service
          </Link>
        </nav>
      </div>
    </footer>
  );
}
