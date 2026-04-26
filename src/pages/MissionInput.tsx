import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight, Sparkles, MapPin } from 'lucide-react';
import { BudgetBand } from '../types';
import LocationAutocomplete from '../components/LocationAutocomplete';
import NavBar from '../components/NavBar';
import Footer from '../components/Footer';
import { useAuth } from '../contexts/AuthContext';

const EXAMPLES = [
  'We empower underserved youth through accessible education programs and mentorship opportunities that build skills for future success.',
  'Our organization provides mental health services to low-income families in rural communities, reducing barriers to care.',
  'We protect and restore natural ecosystems by engaging local communities in environmental stewardship and advocacy.',
];

const BUDGET_BANDS: { key: BudgetBand; label: string; hint: string }[] = [
  { key: 'under_250k', label: 'Under $250K', hint: 'Early-stage and smaller nonprofits' },
  { key: '250k_1m', label: '$250K - $1M', hint: 'Growing organizations with stable programs' },
  { key: '1m_5m', label: '$1M - $5M', hint: 'Mid-sized nonprofits with established operations' },
  { key: 'over_5m', label: '$5M+', hint: 'Large organizations and institutions' },
  { key: 'prefer_not_to_say', label: 'Prefer not to say', hint: 'We will skip budget-fit weighting' },
];

export default function MissionInput() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, userProfile, profileLoaded, saveUserProfile } = useAuth();
  const returnState = location.state as { mission?: string; locationServed?: string; budgetBand?: BudgetBand; keywords?: string[]; prefillMission?: string; prefillLocation?: string } | null;
  const profileAppliedRef = useRef(false);

  // If the user navigated here directly (not via "Update Search"), clear stale session data
  // so the form starts fresh. Only preserve pre-fill when returnState is present.
  useEffect(() => {
    if (!returnState) {
      sessionStorage.removeItem('ff_mission');
      sessionStorage.removeItem('ff_location');
      sessionStorage.removeItem('ff_budget_band');
      sessionStorage.removeItem('ff_keywords');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.title = 'Find Funders for Your Nonprofit | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Describe your nonprofit’s mission and get an instant AI-ranked list of foundations, DAFs, and corporate giving programs aligned to your work.';
  }, []);

  const [mission, setMission] = useState(returnState?.prefillMission || returnState?.mission || '');
  const [locationServed, setLocationServed] = useState(returnState?.prefillLocation || returnState?.locationServed || '');
  const [budgetBand, setBudgetBand] = useState<BudgetBand>(() => {
    if (returnState?.budgetBand && BUDGET_BANDS.some(b => b.key === returnState.budgetBand)) {
      return returnState.budgetBand;
    }
    return 'prefer_not_to_say';
  });
  const [keywords] = useState<string[]>(returnState?.keywords ?? []);
  const [errors, setErrors] = useState<{ mission?: string; location?: string }>({});
  const [showExamples, setShowExamples] = useState(false);

  // Smart redirect: if logged-in user has a saved profile and arrives fresh
  // (not via "Update Search" returnState), skip straight to /results.
  // Otherwise, pre-populate the form from the profile.
  useEffect(() => {
    if (profileAppliedRef.current || !profileLoaded || !userProfile || returnState) return;
    profileAppliedRef.current = true;

    // If the user has a complete profile (mission + location), auto-redirect to results
    if (user && userProfile.mission_statement && userProfile.location_served) {
      const savedBudget: BudgetBand = (userProfile.budget_range && BUDGET_BANDS.some(b => b.key === userProfile.budget_range))
        ? userProfile.budget_range as BudgetBand
        : 'prefer_not_to_say';
      // Also populate sessionStorage so /results can survive reloads
      sessionStorage.setItem('ff_mission', userProfile.mission_statement);
      sessionStorage.setItem('ff_location', userProfile.location_served);
      sessionStorage.setItem('ff_budget_band', savedBudget);
      sessionStorage.setItem('ff_keywords', JSON.stringify([]));
      navigate('/results', {
        state: {
          mission: userProfile.mission_statement,
          locationServed: userProfile.location_served,
          budgetBand: savedBudget,
          keywords: [],
        },
        replace: true,
      });
      return;
    }

    // Otherwise just pre-fill the form
    if (!mission && userProfile.mission_statement) setMission(userProfile.mission_statement);
    if (!locationServed && userProfile.location_served) setLocationServed(userProfile.location_served);
    if (budgetBand === 'prefer_not_to_say' && userProfile.budget_range) {
      const valid = BUDGET_BANDS.some(b => b.key === userProfile.budget_range);
      if (valid) setBudgetBand(userProfile.budget_range as BudgetBand);
    }
  }, [profileLoaded, userProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = () => {
    const newErrors: { mission?: string; location?: string } = {};
    if (!mission.trim()) newErrors.mission = 'Please enter your mission statement to continue.';
    if (!locationServed.trim()) newErrors.location = 'Please enter the location your nonprofit serves.';
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return; }

    // Persist to sessionStorage so Results page survives reloads
    sessionStorage.setItem('ff_mission', mission.trim());
    sessionStorage.setItem('ff_location', locationServed.trim());
    sessionStorage.setItem('ff_budget_band', budgetBand);
    sessionStorage.setItem('ff_keywords', JSON.stringify(keywords));

    // Save to user profile for logged-in users (fire-and-forget)
    if (user) {
      saveUserProfile({
        mission_statement: mission.trim(),
        location_served: locationServed.trim(),
        budget_range: budgetBand,
      }).catch(e => console.warn('Failed to save profile:', e));
    }

    navigate('/results', { state: { mission, locationServed, keywords, budgetBand } });
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
      <NavBar />
      <main id="main-content" className="flex-1 flex flex-col items-center justify-start py-16 px-6">
      <h1 className="text-4xl font-bold mb-3 text-center">Tell Us About Your Mission</h1>
      <p className="text-gray-400 mb-10 text-center">We'll match you with funders who share your vision</p>

      <form
        noValidate
        onSubmit={e => { e.preventDefault(); handleSubmit(); }}
        className="w-full max-w-2xl"
        aria-label="Funder search form"
      >
      <div className="w-full bg-[#161b22] border border-[#30363d] rounded-2xl p-8 space-y-8">

        {/* Mission Statement */}
        <div>
          <label htmlFor="mission-input" className="block text-base font-semibold mb-1">
            Your Mission Statement <span className="text-red-400" aria-hidden="true">*</span>
          </label>
          <p id="mission-desc" className="text-sm text-gray-400 mb-3">Describe what your nonprofit does and who you serve</p>
          <textarea
            id="mission-input"
            value={mission}
            onChange={e => { setMission(e.target.value); setErrors(prev => ({ ...prev, mission: undefined })); }}
            placeholder="Example: We empower underserved youth through accessible education programs and mentorship opportunities that build skills for future success."
            rows={4}
            required
            aria-required="true"
            aria-describedby="mission-desc"
            aria-invalid={!!errors.mission}
            className={`w-full bg-[#0d1117] border rounded-xl px-4 py-3 text-white placeholder-gray-600 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.mission ? 'border-red-500' : 'border-[#30363d]'}`}
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-gray-300">{mission.length} characters</span>
          </div>
          {errors.mission && <p className="text-red-400 text-sm mt-1" aria-live="polite" role="alert">{errors.mission}</p>}

          <button
            type="button"
            onClick={() => setShowExamples(!showExamples)}
            className="flex items-center gap-2 text-gray-400 text-sm mt-3 hover:text-white transition-colors"
          >
            <Sparkles size={16} />
            Show Examples
          </button>

          {showExamples && (
            <div className="mt-3 space-y-2">
              {EXAMPLES.map(ex => (
                <button
                  type="button"
                  key={ex}
                  onClick={() => { setMission(ex); setShowExamples(false); setErrors(prev => ({ ...prev, mission: undefined })); }}
                  className="block w-full text-left text-sm text-gray-300 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-lg p-3 transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Location Served */}
        <div>
          <label htmlFor="location-input" className="block text-base font-semibold mb-1">
            <span className="flex items-center gap-2">
              <MapPin size={16} className="text-blue-400" />
              Location Served <span className="text-red-400" aria-hidden="true">*</span>
            </span>
          </label>
          <p id="location-desc" className="text-sm text-gray-400 mb-3">
            Where does your nonprofit primarily operate or serve communities?
            Funders with geographic alignment will be ranked higher.
          </p>
          <LocationAutocomplete
            value={locationServed}
            onChange={(val) => {
              setLocationServed(val);
              setErrors(prev => ({ ...prev, location: undefined }));
            }}
            hasError={!!errors.location}
            id="location-input"
            required
            ariaDescribedBy="location-desc"
          />
          {errors.location && <p className="text-red-400 text-sm mt-1" aria-live="polite" role="alert">{errors.location}</p>}
        </div>

        {/* Budget band */}
        <div>
          <label className="block text-base font-semibold mb-1">Annual Operating Budget <span className="text-gray-400 font-normal">(Optional)</span></label>
          <p className="text-sm text-gray-400 mb-3">
            We use this to prioritize funders that have supported nonprofits of similar size.
          </p>
          <div role="radiogroup" aria-label="Annual Operating Budget" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {BUDGET_BANDS.map((band) => {
              const selected = budgetBand === band.key;
              return (
                <div
                  key={band.key}
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setBudgetBand(band.key)}
                  onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setBudgetBand(band.key); } }}
                  className={`text-left border rounded-xl px-4 py-3 transition-colors ${
                    selected
                      ? 'border-blue-500 bg-blue-900/30'
                      : 'border-[#30363d] bg-[#0d1117] hover:border-gray-500'
                  }`}
                >
                  <p className={`text-sm font-medium ${selected ? 'text-blue-200' : 'text-white'}`}>{band.label}</p>
                  <p className="text-xs text-gray-400 mt-1">{band.hint}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <button
        type="submit"
        className="mt-8 flex items-center gap-3 bg-white text-gray-900 font-semibold px-10 py-4 rounded-xl text-lg hover:bg-gray-100 transition-colors"
      >
        Find Matching Funders
        <ArrowRight size={20} />
      </button>
      </form>
      </main>
      <Footer />
    </div>
  );
}
