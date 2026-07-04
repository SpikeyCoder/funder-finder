import { Link } from 'react-router-dom';

// Prerendered static landing pages under public/. They are served outside
// the SPA, so they must be plain <a> full-page navigations — a react-router
// <Link> would client-route into the catch-all NotFound. Trailing slashes
// match their canonical URLs (Pages 308-redirects the slashless form).
// These footer links are also their only internal discovery path for
// crawlers; without them the pages are sitemap-orphans.
const RESOURCE_LINKS = [
  { href: '/grants-for-nonprofits/', label: 'Grants for Nonprofits' },
  { href: '/nonprofit-funding-opportunities/', label: 'Funding Opportunities' },
  { href: '/grants-for-501c3/', label: 'Grants for 501(c)(3)s' },
  { href: '/foundation-grants/', label: 'Foundation Grants' },
  { href: '/free-grant-search/', label: 'Free Grant Search' },
];

export default function Footer() {
  return (
    <footer className="w-full border-t border-[#1b2130] bg-[#0d1117] py-8 px-6 mt-auto">
      <nav
        aria-label="Grant resources"
        className="max-w-6xl mx-auto flex flex-wrap items-center justify-center sm:justify-start gap-2 sm:gap-4 mb-4"
      >
        {RESOURCE_LINKS.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            className="inline-flex items-center min-h-[44px] px-2 text-xs text-gray-400 hover:text-white transition-colors"
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs text-gray-400">&copy; {new Date().getFullYear()} Armstrong HoldCo LLC. All rights reserved.</p>
        {/* Footer nav: links wrapped with inline-flex + min-h-[44px] so the
            tap area meets WCAG 2.5.5 / 44x44px touch-target spec on mobile,
            without enlarging the visible text. P3 fix, audit 2026-05-14. */}
        <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-2 sm:gap-4">
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
