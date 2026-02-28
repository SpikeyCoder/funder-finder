import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, BookmarkCheck, Copy, Globe, MapPin, User, Mail, TrendingUp } from 'lucide-react';
import { Funder } from '../types';
import { isSaved, saveFunder, unsaveFunder } from '../utils/storage';
import { formatGrantRange, formatTotalGiving } from '../utils/matching';

export default function FunderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { funder: funderFromState, mission = '', keywords = [] } = location.state || {};

  // Use funder passed in navigation state (avoids extra DB call)
  const [funder] = useState<Funder | null>(funderFromState || null);
  const [saved, setSaved] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);

  useEffect(() => {
    if (id) setSaved(isSaved(id));
  }, [id]);

  if (!funder) return (
    <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
      <div className="text-center">
        <p className="text-2xl font-bold mb-4">Funder not found</p>
        <p className="text-gray-400 text-sm mb-6">Please search for funders first.</p>
        <button onClick={() => navigate('/mission')} className="text-blue-400 hover:underline">Start a search</button>
      </div>
    </div>
  );

  const toggleSave = () => {
    if (saved) { unsaveFunder(funder.id); setSaved(false); }
    else { saveFunder(funder); setSaved(true); }
  };

  const copyEmail = () => {
    if (!funder.contact_email) return;
    navigator.clipboard.writeText(funder.contact_email);
    setCopiedEmail(true);
    setTimeout(() => setCopiedEmail(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-8 transition-colors"
        >
          <ArrowLeft size={18} />
          Back
        </button>

        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-8">
          {/* Header */}
          <div className="flex items-start justify-between mb-2">
            <h1 className="text-3xl font-bold">{funder.name}</h1>
            <button
              onClick={toggleSave}
              className={`flex items-center gap-2 border rounded-xl px-4 py-2 text-sm transition-colors ${saved ? 'border-blue-600 text-blue-400 bg-blue-900/20' : 'border-[#30363d] hover:bg-[#21262d]'}`}
            >
              {saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
              {saved ? 'Saved' : 'Save Funder'}
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-sm px-3 py-1 rounded-full capitalize">
              {funder.type}
            </span>
            {funder.ntee_code && (
              <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-400 text-sm px-3 py-1 rounded-full">
                NTEE {funder.ntee_code}
              </span>
            )}
          </div>

          {/* AI match reason */}
          {funder.reason && (
            <div className="mb-6 bg-[#0d1117] border border-blue-900/50 rounded-xl px-4 py-3">
              <p className="text-xs text-blue-400 font-semibold mb-1">Why this funder matches your mission</p>
              <p className="text-gray-300 text-sm">{funder.reason}</p>
              {funder.score && (
                <p className="text-xs text-gray-500 mt-2">Match score: {Math.round(funder.score * 100)}%</p>
              )}
            </div>
          )}

          <hr className="border-[#30363d] mb-6" />

          {/* Focus Areas */}
          {funder.focus_areas && funder.focus_areas.length > 0 && (
            <>
              <div id="focus-areas" className="mb-6">
                <h2 className="text-lg font-semibold mb-3">Focus Areas</h2>
                <div className="flex flex-wrap gap-2">
                  {funder.focus_areas.map(area => (
                    <span key={area} className="bg-[#21262d] border border-[#30363d] text-gray-300 text-sm px-3 py-1 rounded-full capitalize">
                      {area.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* Giving Stats */}
          {(funder.total_giving || funder.grant_range_min || funder.grant_range_max) && (
            <>
              <div id="giving" className="mb-6">
                <h2 className="text-lg font-semibold mb-3">Giving Overview</h2>
                <div className="grid grid-cols-2 gap-4">
                  {funder.total_giving && (
                    <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <TrendingUp size={14} className="text-green-400" />
                        <p className="text-xs text-gray-400">Annual Giving</p>
                      </div>
                      <p className="text-white font-semibold">{formatTotalGiving(funder.total_giving)}</p>
                    </div>
                  )}
                  {(funder.grant_range_min || funder.grant_range_max) && (
                    <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
                      <p className="text-xs text-gray-400 mb-1">Typical Grant</p>
                      <p className="text-white font-semibold">{formatGrantRange(funder)}</p>
                    </div>
                  )}
                </div>
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* Recommended Next Step */}
          {funder.next_step && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-semibold mb-3">Recommended Next Step</h2>
                <div className="bg-[#0d1117] border border-blue-800 rounded-xl px-5 py-4 text-blue-300">
                  {(() => {
                    // Normalise to a fully-qualified external URL:
                    //  - Strip stale cached GitHub Pages funder paths (e.g. https://...github.io/.../funder/cct.org)
                    //  - Reject internal routes starting with '/'
                    //  - Prepend https:// for bare domains (e.g. cct.org)
                    const STALE_RE = /^https?:\/\/[^/]*\.github\.io\/[^/]+\/funder\//;
                    const toExtUrl = (u: string | null | undefined) => {
                      let s = u?.trim();
                      if (!s) return null;
                      s = s.replace(STALE_RE, '');
                      if (!s || s.startsWith('/')) return null;
                      return s.startsWith('http') ? s : `https://${s}`;
                    };
                    const linkUrl = toExtUrl(funder.next_step_url) ?? toExtUrl(funder.website);
                    return linkUrl ? (
                      <a
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-blue-200 underline underline-offset-2 transition-colors"
                      >
                        {funder.next_step}
                      </a>
                    ) : (
                      funder.next_step
                    );
                  })()}
                </div>
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

          {/* Contact Information */}
          <div id="contact" className="mb-2">
            <h2 className="text-lg font-semibold mb-4">Contact Information</h2>
            <div className="space-y-5">
              {(funder.contact_name || funder.contact_title) && (
                <div className="flex items-start gap-3">
                  <User size={18} className="text-gray-500 mt-0.5" />
                  <div>
                    {funder.contact_name && <p className="font-medium">{funder.contact_name}</p>}
                    {funder.contact_title && <p className="text-sm text-gray-400">{funder.contact_title}</p>}
                  </div>
                </div>
              )}

              {funder.contact_email ? (
                <div className="flex items-start gap-3">
                  <Mail size={18} className="text-gray-500 mt-0.5" />
                  <div>
                    <p className="text-gray-300">{funder.contact_email}</p>
                    <button
                      onClick={copyEmail}
                      className="flex items-center gap-1 text-sm border border-[#30363d] rounded-lg px-3 py-1 mt-2 hover:bg-[#21262d] transition-colors"
                    >
                      <Copy size={13} />
                      {copiedEmail ? 'Copied!' : 'Copy Email'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-gray-500">
                  <Mail size={18} />
                  <p className="text-sm">No direct email available</p>
                </div>
              )}

              {(funder.city || funder.state) && (
                <div className="flex items-center gap-3">
                  <MapPin size={18} className="text-gray-500" />
                  <p className="text-gray-300">
                    {[funder.city, funder.state].filter(Boolean).join(', ')}
                  </p>
                </div>
              )}

              {funder.website ? (
                <div className="flex items-center gap-3">
                  <Globe size={18} className="text-gray-500" />
                  <a
                    href={funder.website.startsWith('http') ? funder.website : `https://${funder.website}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline break-all"
                  >
                    {funder.website} ↗
                  </a>
                </div>
              ) : (
                <div className="flex items-center gap-3 text-gray-500">
                  <Globe size={18} />
                  <p className="text-sm">No website available</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Bottom nav */}
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => navigate('/results', { state: { mission, keywords } })}
            className="flex-1 border border-[#30363d] rounded-xl py-3 text-sm hover:bg-[#161b22] transition-colors"
          >
            ← Back to Results
          </button>
          <button
            onClick={() => navigate('/saved')}
            className="flex-1 border border-[#30363d] rounded-xl py-3 text-sm hover:bg-[#161b22] transition-colors"
          >
            View Saved Funders
          </button>
        </div>
      </div>
    </div>
  );
}
