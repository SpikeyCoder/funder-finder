import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="w-full border-t border-[#1b2130] bg-[#0d1117] py-8 px-6 mt-auto">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs text-gray-400">&copy; {new Date().getFullYear()} FunderMatch. All rights reserved.</p>
        <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-4">
          <Link to="/contact" className="text-xs text-gray-400 hover:text-white transition-colors">Contact</Link>
          <Link to="/privacy" className="text-xs text-gray-400 hover:text-white transition-colors">Privacy Policy</Link>
          <Link to="/terms" className="text-xs text-gray-400 hover:text-white transition-colors">Terms of Service</Link>
        </nav>
      </div>
    </footer>
  );
}
