import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, ChevronLeft, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, getEdgeFunctionHeaders } from '../lib/supabase';
import NavBar from '../components/NavBar';

const MATCH_FUNDERS_URL = 'https://auth.fundermatch.org/functions/v1/match-funders';

interface SearchCriteria {
  locations: string[];
  fields_of_work: string[];
  funding_types: string[];
  keywords: string[];
  min_grant_size?: number;
  max_grant_size?: number;
}

interface FormState {
  name: string;
  description: string;
  search_criteria: SearchCriteria;
}

const STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY'
];

const NTEE_CATEGORIES = [
  { code: 'A', label: 'Arts, Culture & Humanities' },
  { code: 'B', label: 'Education & Research' },
  { code: 'C', label: 'Environment & Animals' },
  { code: 'D', label: 'Health' },
  { code: 'E', label: 'Mental Health & Substance Abuse' },
  { code: 'F', label: 'Crime & Legal Services' },
  { code: 'G', label: 'Employment' },
  { code: 'H', label: 'Food, Agriculture & Nutrition' },
  { code: 'I', label: 'Housing & Shelter' },
  { code: 'J', label: 'Public Safety' },
  { code: 'K', label: 'Recreation & Sports' },
  { code: 'L', label: 'Youth Development' },
  { code: 'M', label: 'Philanthropy & Civil Society' },
  { code: 'N', label: 'Religion' },
  { code: 'O', label: 'Mutual & Membership Benefit' },
  { code: 'P', label: 'Government & Public Administration' },
  { code: 'Q', label: 'International, Foreign Affairs' },
  { code: 'R', label: 'Public Utilities & Public Services' },
  { code: 'S', label: 'Transportation' },
  { code: 'T', label: 'Grantmaking & Giving Services' },
  { code: 'U', label: 'Science & Technology' },
  { code: 'V', label: 'Social Sciences' },
  { code: 'W', label: 'Public & Societal Benefit' },
  { code: 'X', label: 'Religion - Unspecified' },
  { code: 'Y', label: 'Unknown' },
  { code: 'Z', label: 'Unclassified' }
];

const FUNDING_TYPES = [
  { value: 'general_operating', label: 'General Operating Support' },
  { value: 'project_program', label: 'Project/Program Support' },
  { value: 'capital', label: 'Capital Support' },
  { value: 'capacity_building', label: 'Capacity Building' }
];

const GRANT_SIZE_PRESETS = [
  { label: 'Up to $50K', min: 0, max: 50000 },
  { label: '$50K - $250K', min: 50000, max: 250000 },
  { label: '$250K - $1M', min: 250000, max: 1000000 },
  { label: '$1M+', min: 1000000, max: null }
];

export default function NewProjectPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>({
    name: '',
    description: '',
    search_criteria: {
      locations: [],
      fields_of_work: [],
      funding_types: [],
      keywords: []
    }
  });
  const [currentKeyword, setCurrentKeyword] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/');
    }
  }, [user, loading, navigate]);

  const handleLocationToggle = (state: string) => {
    setForm(prev => ({
      ...prev,
      search_criteria: {
        ...prev.search_criteria,
        locations: prev.search_criteria.locations.includes(state)
          ? prev.search_criteria.locations.filter(s => s !== state)
          : [...prev.search_criteria.locations, state]
      }
    }));
  };

  const handleFieldToggle = (code: string) => {
    setForm(prev => ({
      ...prev,
      search_criteria: {
        ...prev.search_criteria,
        fields_of_work: prev.search_criteria.fields_of_work.includes(code)
          ? prev.search_criteria.fields_of_work.filter(c => c !== code)
          : [...prev.search_criteria.fields_of_work, code]
      }
    }));
  };

  const handleFundingTypeToggle = (type: string) => {
    setForm(prev => ({
      ...prev,
      search_criteria: {
        ...prev.search_criteria,
        funding_types: prev.search_criteria.funding_types.includes(type)
          ? prev.search_criteria.funding_types.filter(t => t !== type)
          : [...prev.search_criteria.funding_types, type]
      }
    }));
  };

  const handleAddKeyword = (keyword: string) => {
    if (keyword.trim() && !form.search_criteria.keywords.includes(keyword.trim())) {
      setForm(prev => ({
        ...prev,
        search_criteria: {
          ...prev.search_criteria,
          keywords: [...prev.search_criteria.keywords, keyword.trim()]
        }
      }));
      setCurrentKeyword('');
    }
  };

  const handleRemoveKeyword = (keyword: string) => {
    setForm(prev => ({
      ...prev,
      search_criteria: {
        ...prev.search_criteria,
        keywords: prev.search_criteria.keywords.filter(k => k !== keyword)
      }
    }));
  };

  const handleGrantSizePreset = (min: number, max: number | null) => {
    setForm(prev => ({
      ...prev,
      search_criteria: {
        ...prev.search_criteria,
        min_grant_size: min,
        max_grant_size: max || undefined
      }
    }));
  };

  const handleCreateProject = async () => {
    if (!form.name.trim()) {
      setError('Project name is required');
      return;
    }
    if (!form.description.trim()) {
      setError('Mission description is required');
      return;
    }

    try {
      setCreating(true);
      setError(null);

      // Verify session is still valid before attempting insert
      const { data: sessionData } = await supabase.auth.getSession();
      const activeUser = sessionData.session?.user;
      if (!activeUser) {
        setError('Your session has expired. Please sign in again.');
        navigate('/');
        return;
      }

      // Map form search_criteria to the actual DB columns
      const locationScope = form.search_criteria.locations.length > 0
        ? form.search_criteria.locations.map(s => ({ state: s }))
        : null;

      const { data, error: insertError } = await supabase
        .from('projects')
        .insert({
          user_id: activeUser.id,
          name: form.name.trim(),
          description: form.description.trim() || null,
          location_scope: locationScope,
          fields_of_work: form.search_criteria.fields_of_work.length > 0 ? form.search_criteria.fields_of_work : null,
          funding_types: form.search_criteria.funding_types.length > 0 ? form.search_criteria.funding_types : null,
          keywords: form.search_criteria.keywords.length > 0 ? form.search_criteria.keywords : null,
          budget_min: form.search_criteria.min_grant_size || null,
          budget_max: form.search_criteria.max_grant_size || null,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // Trigger match computation and store results
      try {
        const headers = await getEdgeFunctionHeaders();
        const matchRes = await fetch(MATCH_FUNDERS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({
            mission: form.description || form.name,
            locationServed: form.search_criteria.locations.join(', ') || undefined,
            keywords: form.search_criteria.keywords.length > 0
              ? form.search_criteria.keywords
              : form.search_criteria.fields_of_work.length > 0
                ? form.search_criteria.fields_of_work.map(
                    code => NTEE_CATEGORIES.find(c => c.code === code)?.label || code
                  )
                : undefined,
            budgetBand: form.search_criteria.min_grant_size
              ? `${form.search_criteria.min_grant_size}-${form.search_criteria.max_grant_size || ''}`
              : undefined,
          }),
        });

        if (matchRes.ok) {
          const matchData = await matchRes.json();
          const results = Array.isArray(matchData.results) ? matchData.results : [];
          if (results.length > 0) {
            const rows = results.slice(0, 50).map((r: any) => ({
              project_id: data.id,
              funder_ein: r.foundation_ein || r.id || '',
              funder_name: r.name || r.foundation_ein || '',
              match_score: Math.round((r.fit_score || 0) * 100),
              match_reasons: r.fit_explanation || null,
              gives_to_peers: !!r.gives_to_peers,
              computed_at: new Date().toISOString(),
            }));
            const validRows = rows.filter((r: any) => r.funder_ein);
            if (validRows.length > 0) {
              await supabase.from('project_matches').insert(validRows);
            }
          }
        }
      } catch (matchErr) {
        console.warn('Match computation failed (non-blocking):', matchErr);
      }

      navigate(`/projects/${data.id}`);
    } catch (err: any) {
      console.error('Error creating project:', err);
      const msg = err?.message || err?.error_description || 'Unknown error';
      if (msg.includes('JWT') || msg.includes('token') || msg.includes('auth')) {
        setError('Your session has expired. Please sign in again.');
      } else {
        setError(`Failed to create project: ${msg}`);
      }
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <>
        <NavBar />
        <main className="min-h-screen bg-[#0d1117] pt-20 px-4 flex items-center justify-center">
          <div className="text-gray-400">Loading...</div>
        </main>
      </>
    );
  }

  return (
    <>
      <NavBar />
      <main className="min-h-screen bg-[#0d1117] pt-20 px-4 sm:px-6 lg:px-8 pb-12">
        <div className="max-w-2xl mx-auto">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Create a New Project</h1>
            <p className="text-gray-400">Define your funding search criteria</p>
          </div>

          {/* Progress Bar */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white">Step {step} of 3</span>
              </div>
            </div>
            <div className="w-full bg-[#161b22] border border-[#30363d] rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{ width: `${(step / 3) * 100}%` }}
              />
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-900/20 border border-red-800 rounded-lg text-red-200">
              {error}
            </div>
          )}

          {/* Form Container */}
          <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6 sm:p-8 mb-8">
            {/* Step 1: Basics */}
            {step === 1 && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-white mb-2">
                    Project Name *
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g., Community Health Initiative"
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-white mb-2">
                    Mission / Description *
                  </label>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Describe your project mission and goals — this is used to find matching funders..."
                    rows={4}
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                </div>
              </div>
            )}

            {/* Step 2: Search Criteria */}
            {step === 2 && (
              <div className="space-y-8">
                {/* Locations */}
                <div>
                  <label className="block text-sm font-medium text-white mb-4">
                    States
                  </label>
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {STATES.map(state => (
                      <label
                        key={state}
                        className="flex items-center cursor-pointer group"
                      >
                        <input
                          type="checkbox"
                          checked={form.search_criteria.locations.includes(state)}
                          onChange={() => handleLocationToggle(state)}
                          className="rounded border-[#30363d] bg-[#0d1117] text-blue-600 cursor-pointer"
                        />
                        <span className="ml-2 text-sm text-gray-400 group-hover:text-white transition-colors">
                          {state}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Fields of Work */}
                <div>
                  <label className="block text-sm font-medium text-white mb-4">
                    Fields of Work
                  </label>
                  <div className="space-y-2">
                    {NTEE_CATEGORIES.map(category => (
                      <label
                        key={category.code}
                        className="flex items-center cursor-pointer group"
                      >
                        <input
                          type="checkbox"
                          checked={form.search_criteria.fields_of_work.includes(category.code)}
                          onChange={() => handleFieldToggle(category.code)}
                          className="rounded border-[#30363d] bg-[#0d1117] text-blue-600 cursor-pointer"
                        />
                        <span className="ml-2 text-sm text-gray-400 group-hover:text-white transition-colors">
                          {category.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Funding Types */}
                <div>
                  <label className="block text-sm font-medium text-white mb-4">
                    Funding Types
                  </label>
                  <div className="space-y-2">
                    {FUNDING_TYPES.map(type => (
                      <label
                        key={type.value}
                        className="flex items-center cursor-pointer group"
                      >
                        <input
                          type="checkbox"
                          checked={form.search_criteria.funding_types.includes(type.value)}
                          onChange={() => handleFundingTypeToggle(type.value)}
                          className="rounded border-[#30363d] bg-[#0d1117] text-blue-600 cursor-pointer"
                        />
                        <span className="ml-2 text-sm text-gray-400 group-hover:text-white transition-colors">
                          {type.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {/* Keywords */}
                <div>
                  <label className="block text-sm font-medium text-white mb-4">
                    Keywords
                  </label>
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={currentKeyword}
                        onChange={(e) => setCurrentKeyword(e.target.value)}
                        onKeyPress={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddKeyword(currentKeyword);
                          }
                        }}
                        placeholder="Enter a keyword and press Enter"
                        className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                      />
                    </div>
                    {form.search_criteria.keywords.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {form.search_criteria.keywords.map(keyword => (
                          <div
                            key={keyword}
                            className="flex items-center gap-2 bg-blue-600 text-white px-3 py-1 rounded-full text-sm"
                          >
                            <span>{keyword}</span>
                            <button
                              onClick={() => handleRemoveKeyword(keyword)}
                              className="hover:opacity-80"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Grant Size Range */}
                <div>
                  <label className="block text-sm font-medium text-white mb-4">
                    Grant Size Range
                  </label>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      {GRANT_SIZE_PRESETS.map(preset => (
                        <button
                          key={preset.label}
                          onClick={() => handleGrantSizePreset(preset.min, preset.max)}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            form.search_criteria.min_grant_size === preset.min &&
                            form.search_criteria.max_grant_size === preset.max
                              ? 'bg-blue-600 text-white'
                              : 'bg-[#0d1117] text-gray-400 border border-[#30363d] hover:text-white'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Step 3: Review */}
            {step === 3 && (
              <div className="space-y-6">
                <div className="bg-[#0d1117] rounded-lg p-4 space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-400">Project Name</h3>
                    <p className="text-white mt-1">{form.name || '(Not provided)'}</p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-gray-400">Mission / Description</h3>
                    <p className="text-white mt-1">{form.description || '(Not provided)'}</p>
                  </div>
                </div>

                <div className="bg-[#0d1117] rounded-lg p-4 space-y-3">
                  <h3 className="font-medium text-white">Search Criteria</h3>

                  {form.search_criteria.locations.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-400 uppercase">States</p>
                      <p className="text-sm text-gray-300 mt-1">
                        {form.search_criteria.locations.join(', ')}
                      </p>
                    </div>
                  )}

                  {form.search_criteria.fields_of_work.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-400 uppercase">Fields of Work</p>
                      <p className="text-sm text-gray-300 mt-1">
                        {form.search_criteria.fields_of_work
                          .map(code =>
                            NTEE_CATEGORIES.find(c => c.code === code)?.label || code
                          )
                          .join(', ')}
                      </p>
                    </div>
                  )}

                  {form.search_criteria.funding_types.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-400 uppercase">Funding Types</p>
                      <p className="text-sm text-gray-300 mt-1">
                        {form.search_criteria.funding_types
                          .map(type =>
                            FUNDING_TYPES.find(t => t.value === type)?.label || type
                          )
                          .join(', ')}
                      </p>
                    </div>
                  )}

                  {form.search_criteria.keywords.length > 0 && (
                    <div>
                      <p className="text-xs text-gray-400 uppercase">Keywords</p>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {form.search_criteria.keywords.map(keyword => (
                          <span
                            key={keyword}
                            className="bg-blue-600/20 text-blue-300 px-2 py-1 rounded text-sm"
                          >
                            {keyword}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {(form.search_criteria.min_grant_size != null || form.search_criteria.max_grant_size != null) && (
                    <div>
                      <p className="text-xs text-gray-400 uppercase">Grant Size Range</p>
                      <p className="text-sm text-gray-300 mt-1">
                        {form.search_criteria.min_grant_size != null
                          ? `$${form.search_criteria.min_grant_size.toLocaleString()}`
                          : 'Any'}{' '}
                        -{' '}
                        {form.search_criteria.max_grant_size != null
                          ? `$${form.search_criteria.max_grant_size.toLocaleString()}`
                          : 'No limit'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Navigation Buttons */}
          <div className="flex gap-4">
            <button
              onClick={() => setStep(Math.max(1, step - 1))}
              disabled={step === 1 || creating}
              className="flex items-center gap-2 px-6 py-2 border border-[#30363d] rounded-lg text-white hover:bg-[#161b22] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft size={18} />
              Back
            </button>

            {step < 3 ? (
              <button
                onClick={() => {
                  if (step === 1) {
                    if (!form.name.trim()) {
                      setError('Project name is required');
                      return;
                    }
                    if (!form.description.trim()) {
                      setError('Mission description is required — it\'s used to find matching funders');
                      return;
                    }
                  }
                  setError(null);
                  setStep(step + 1);
                }}
                className="flex items-center gap-2 ml-auto px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-medium transition-colors"
              >
                Next
                <ChevronRight size={18} />
              </button>
            ) : (
              <button
                onClick={handleCreateProject}
                disabled={creating || !form.name.trim() || !form.description.trim()}
                className="ml-auto px-6 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? 'Creating...' : 'Create Project'}
              </button>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
