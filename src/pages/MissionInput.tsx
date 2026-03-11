import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight, Sparkles, X, Plus, MapPin } from 'lucide-react';
import { BudgetBand } from '../types';

const SUGGESTED_KEYWORDS = [
  'early childhood education',
  'pre-k readiness',
  'kindergarten readiness',
  'elementary reading intervention',
  'middle school tutoring',
  'high school college readiness',
  'adult literacy',
  'english language learning',
  'special education inclusion',
  'college access',
  'college persistence',
  'after-school stem',
  'workforce development',
  'career and technical education',
  'mental health counseling',
  'substance use recovery',
  'housing assistance',
  'homeless services',
  'food insecurity',
  'maternal health',
  'disability services',
  'domestic violence prevention',
  'immigrant legal aid',
  'climate adaptation',
  'land conservation',
  'arts education',
  'criminal legal reform',
];

const EXAMPLES = [
  'We empower underserved youth through accessible education programs and mentorship opportunities that build skills for future success.',
  'Our organization provides mental health services to low-income families in rural communities, reducing barriers to care.',
  'We protect and restore natural ecosystems by engaging local communities in environmental stewardship and advocacy.',
];

const LOCATION_SUGGESTIONS = [
  'National (United States)',
  'International / Global',
  'New York, NY',
  'Los Angeles, CA',
  'Chicago, IL',
  'Seattle, WA',
  'Texas',
  'California',
  'Northeast United States',
  'Rural communities',
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
  const returnState = location.state as { mission?: string; locationServed?: string; budgetBand?: BudgetBand; keywords?: string[] } | null;

  useEffect(() => {
    document.title = 'Find Funders for Your Nonprofit | FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Describe your nonprofit\u2019s mission and get an instant AI-ranked list of foundations, DAFs, and corporate giving programs aligned to your work.';
  }, []);

  const [mission, setMission] = useState(returnState?.mission || sessionStorage.getItem('ff_mission') || '');
  const [locationServed, setLocationServed] = useState(returnState?.locationServed || sessionStorage.getItem('ff_location') || '');
  const [budgetBand, setBudgetBand] = useState<BudgetBand>(() => {
    if (returnState?.budgetBand && BUDGET_BANDS.some(b => b.key === returnState.budgetBand)) {
      return returnState.budgetBand;
    }
    const saved = sessionStorage.getItem('ff_budget_band') as BudgetBand | null;
    if (saved && BUDGET_BANDS.some(b => b.key === saved)) {
      return saved;
    }
    return 'prefer_not_to_say';
  });
  const [keywords, setKeywords] = useState<string[]>(returnState?.keywords ?? JSON.parse(sessionStorage.getItem('ff_keywords') || '[]'));
  const [keywordInput, setKeywordInput] = useState('');
  const [errors, setErrors] = useState<{ mission?: string; location?: string }>({});
  const [showExamples, setShowExamples] = useState(false);
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false);

  const addKeyword = (kw: string) => {
    const trimmed = kw.trim().toLowerCase();
    if (trimmed && !keywords.includes(trimmed)) {
      setKeywords([...keywords, trimmed]);
    }
    setKeywordInput('');
  };

  const removeKeyword = (kw: string) => {
    setKeywords(keywords.filter(k => k !== kw));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && keywordInput.trim()) {
      addKeyword(keywordInput);
    }
  };

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
    navigate('/results', { state: { mission, locationServed, keywords, budgetBand } });
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col items-center justify-start py-16 px-6">
      <h1 className="text-4xl font-bold mb-3 text-center">Tell Us About Your Mission</h1>
      <p className="text-gray-400 mb-10 text-center">We'll match you with funders who share your vision</p>

      <div className="w-full max-w-2xl bg-[#161b22] border border-[#30363d] rounded-2xl p-8 space-y-8">

        {/* Mission Statement */}
        <div>
          <label className="block text-base font-semibold mb-1">
            Your Mission Statement <span className="text-red-400">*</span>
          </label>
          <p className="text-sm text-gray-400 mb-3">Describe what your nonprofit does and who you serve</p>
          <textarea
            value={mission}
            onChange={e => { setMission(e.target.value); setErrors(prev => ({ ...prev, mission: undefined })); }}
            placeholder="Example: We empower underserved youth through accessible education programs and mentorship opportunities that build skills for future success."
            rows={4}
            className={`w-full bg-[#0d1117] border rounded-xl px-4 py-3 text-white placeholder-gray-600 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.mission ? 'border-red-500' : 'border-[#30363d]'}`}
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-gray-300">{mission.length} characters</span>
          </div>
          {errors.mission && <p className="text-red-400 text-sm mt-1">{errors.mission}</p>}

          <button
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
          <label className="block text-base font-semibold mb-1">
            <span className="flex items-center gap-2">
              <MapPin size={16} className="text-blue-400" />
              Location Served <span className="text-red-400">*</span>
            </span>
          </label>
          <p className="text-sm text-gray-400 mb-3">
            Where does your nonprofit primarily operate or serve communities?
            Funders with geographic alignment will be ranked higher.
          </p>
          <div className="relative">
            <input
              value={locationServed}
              onChange={e => {
                setLocationServed(e.target.value);
                setErrors(prev => ({ ...prev, location: undefined }));
                setShowLocationSuggestions(true);
              }}
              onFocus={() => setShowLocationSuggestions(true)}
              onBlur={() => setTimeout(() => setShowLocationSuggestions(false), 150)}
              placeholder="e.g. Seattle, WA · Chicago, IL · Rural Appalachia · National"
              className={`w-full bg-[#0d1117] border rounded-xl px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.location ? 'border-red-500' : 'border-[#30363d]'}`}
            />
            {showLocationSuggestions && !locationServed && (
              <div className="absolute z-10 w-full mt-1 bg-[#21262d] border border-[#30363d] rounded-xl overflow-hidden shadow-lg">
                {LOCATION_SUGGESTIONS.map(suggestion => (
                  <button
                    key={suggestion}
                    onMouseDown={() => {
                      setLocationServed(suggestion);
                      setShowLocationSuggestions(false);
                      setErrors(prev => ({ ...prev, location: undefined }));
                    }}
                    className="flex items-center gap-2 w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-[#30363d] transition-colors"
                  >
                    <MapPin size={12} className="text-gray-400 shrink-0" />
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
          {errors.location && <p className="text-red-400 text-sm mt-1">{errors.location}</p>}
        </div>

        {/* Budget band */}
        <div>
          <label className="block text-base font-semibold mb-1">Annual Operating Budget <span className="text-gray-400 font-normal">(Optional)</span></label>
          <p className="text-sm text-gray-400 mb-3">
            We use this to prioritize funders that have supported nonprofits of similar size.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {BUDGET_BANDS.map((band) => {
              const selected = budgetBand === band.key;
              return (
                <button
                  key={band.key}
                  type="button"
                  onClick={() => setBudgetBand(band.key)}
                  className={`text-left border rounded-xl px-4 py-3 transition-colors ${
                    selected
                      ? 'border-blue-500 bg-blue-900/30'
                      : 'border-[#30363d] bg-[#0d1117] hover:border-gray-500'
                  }`}
                >
                  <p className={`text-sm font-medium ${selected ? 'text-blue-200' : 'text-white'}`}>{band.label}</p>
                  <p className="text-xs text-gray-400 mt-1">{band.hint}</p>
                </button>
              );
            })}
          </div>
        </div>

        {/* Exclusion Keywords */}
        <div>
          <label className="block text-base font-semibold mb-1">Keywords to Exclude from Search</label>
          <p className="text-sm text-gray-400 mb-3">
            Add funding areas you do not want. Funder matches with overlap will be downweighted.
          </p>

          <div className="flex gap-2">
            <input
              value={keywordInput}
              onChange={e => setKeywordInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type an exclusion keyword and press Enter"
              className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={() => addKeyword(keywordInput)}
              className="bg-[#21262d] border border-[#30363d] rounded-xl p-3 hover:bg-[#30363d] transition-colors"
            >
              <Plus size={20} />
            </button>
          </div>

          {keywords.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {keywords.map(kw => (
                <span key={kw} className="flex items-center gap-1 bg-blue-900/50 border border-blue-700 text-blue-300 px-3 py-1 rounded-full text-sm">
                  {kw}
                  <button onClick={() => removeKeyword(kw)} className="hover:text-white ml-1">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="mt-4">
            <p className="text-xs text-gray-300 mb-2">Suggested granular exclusions:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_KEYWORDS.filter(k => !keywords.includes(k)).map(kw => (
                <button
                  key={kw}
                  onClick={() => addKeyword(kw)}
                  className="text-sm text-gray-400 border border-[#30363d] rounded-full px-3 py-1 hover:border-blue-500 hover:text-blue-300 transition-colors"
                >
                  + {kw}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        className="mt-8 flex items-center gap-3 bg-white text-gray-900 font-semibold px-10 py-4 rounded-xl text-lg hover:bg-gray-100 transition-colors"
      >
        Find Matching Funders
        <ArrowRight size={20} />
      </button>
    </div>
  );
}
