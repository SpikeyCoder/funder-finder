import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, BookmarkCheck, Copy, Globe, MapPin, User, Mail, TrendingUp } from 'lucide-react';
import { Funder } from '../types';
import { isSaved, saveFunder, unsaveFunder } from '../utils/storage';
import { formatGrantRange, formatTotalGiving } from '../utils/matching';
import { useAuth } from '../contexts/AuthContext';
import LoginModal from '../components/LoginModal';

function formatGrantAmount(amount: number | null | undefined): string {
  if (!amount || !Number.isFinite(amount)) return 'Amount not disclosed';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}

export default function FunderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { funder: funderFromState, mission = '', keywords = [] } = location.state || {};
  const { user, saveFunderToDB, unsaveFunderFromDB } = useAuth();

  // Use funder passed in navigation state (avoids extra DB call)
  const [funder] = useState<Funder | null>(funderFromState || null);
  const [saved, setSaved] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);

  // Page title — use funder name when available
  useEffect(() => {
    const name = funder?.name ? `${funder.name} | FunderMatch` : 'Funder Details | FunderMatch';
    document.title = name;
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = funder?.name
      ? `View contact info, mission alignment, and grant details for ${funder.name}. Generate a tailored grant application in seconds.`
      : 'View funder contact info, mission alignment scores, and generate a tailored grant application.';
  }, [funder]);

  useEffect(() => {
    if (id) {
      if (user) {
        // For logged-in users, we check the DB; but a quick sync from the
        // Results page has already loaded savedIds. For simplicity here
        // we fall back to localStorage state which is synced in Results.
        setSaved(isSaved(id));
      } else {
        setSaved(isSaved(id));
      }
    }
  }, [id, user]);

  if (!funder) return (
    <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
      <div className="text-center">
        <p className="text-2xl font-bold mb-4">Funder not found</p>
        <p className="text-gray-400 text-sm mb-6">Please search for funders first.</p>
        <button onClick={() => navigate('/mission')} className="text-blue-400 hover:underline">Start a search</button>
      </div>
    </div>
  );

  const toggleSave = async () => {
    if (user) {
      // Authenticated path — use DB
      if (saved) {
        try {
          await unsaveFunderFromDB(funder.id);
          unsaveFunder(funder.id); // keep localStorage in sync
          setSaved(false);
        } catch (e) {
          console.error('Failed to unsave from DB:', e);
        }
      } else {
        try {
          await saveFunderToDB(funder);
          saveFunder(funder); // keep localStorage in sync
          setSaved(true);
        } catch (e) {
          console.error('Failed to save to DB:', e);
        }
      }
    } else {
      // Anonymous path
      if (saved) {
        unsaveFunder(funder.id);
        setSaved(false);
      } else {
        // Show login modal; funder will be auto-saved after OAuth redirect
        setShowLoginModal(true);
      }
    }
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
          {(funder.fit_explanation || funder.reason) && (
            <div className="mb-6 bg-[#0d1117] border border-blue-900/50 rounded-xl px-4 py-3">
              <p className="text-xs text-blue-400 font-semibold mb-1">Why this funder matches your mission</p>
              <p className="text-gray-300 text-sm">{funder.fit_explanation || funder.reason}</p>
              {funder.score && (
                <p className="text-xs text-gray-300 mt-2">Match score: {Math.round(funder.score * 100)}%</p>
              )}
            </div>
          )}

          <hr className="border-[#30363d] mb-6" />

          {/* Similar past grantees */}
          {funder.similar_past_grantees && funder.similar_past_grantees.length > 0 && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-semibold mb-3">Similar Past Grantees</h2>
                <p className="text-xs text-blue-400 font-semibold mb-3">Top 3 related grantees used in your match</p>
                <div className="space-y-3">
                  {funder.similar_past_grantees.slice(0, 3).map((grantee, idx) => (
                    <div key={`${funder.id}-detail-grantee-${idx}`} className="border border-[#30363d] rounded-lg p-3 bg-[#0d1117]">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <p className="text-sm font-semibold text-white">{grantee.name}</p>
                        <p className="text-xs text-gray-300">
                          {(grantee.year ? String(grantee.year) : 'Year n/a')} · {formatGrantAmount(grantee.amount)}
                        </p>
                      </div>
                      {grantee.match_reasons.length > 0 && (
                        <ul className="list-disc ml-4 text-xs text-gray-300 space-y-1">
                          {grantee.match_reasons.slice(0, 2).map((reason, reasonIdx) => (
                            <li key={`${funder.id}-detail-grantee-${idx}-reason-${reasonIdx}`}>{reason}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <hr className="border-[#30363d] mb-6" />
            </>
          )}

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
                  <User size={18} className="text-gray-400 mt-0.5" />
                  <div>
                    {funder.contact_name && <p className="font-medium">{funder.contact_name}</p>}
                    {funder.contact_title && <p className="text-sm text-gray-400">{funder.contact_title}</p>}
                  </div>
                </div>
              )}

              {funder.contact_email ? (
                <div className="flex items-start gap-3">
                  <Mail size={18} className="text-gray-400 mt-0.5" />
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
                <div className="flex items-center gap-3 text-gray-400">
                  <Mail size={18} />
                  <p className="text-sm">No direct email available</p>
                </div>
              )}

              {(funder.city || funder.state) && (
                <div className="flex items-center gap-3">
                  <MapPin size={18} className="text-gray-400" />
                  <p className="text-gray-300">
                    {[funder.city, funder.state].filter(Boolean).join(', ')}
                  </p>
                </div>
              )}

              {funder.website ? (
                <div className="flex items-center gap-3">
                  <Globe size={18} className="text-gray-400" />
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
                <div className="flex items-center gap-3 text-gray-400">
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

      {/* Login modal — shown when anonymous user tries to save */}
      {showLoginModal && (
        <LoginModal
          pendingFunder={funder}
          onClose={() => setShowLoginModal(false)}
        />
      )}
    </div>
  );
}
