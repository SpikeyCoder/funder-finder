import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, AlertCircle, CheckCircle, Loader, Building2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import AuthGuard from '../components/AuthGuard';

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'
];

const NTEE_CATEGORIES = [
  { code: 'A', label: 'Arts, Culture & Humanities' },
  { code: 'B', label: 'Education & Research' },
  { code: 'C', label: 'Environment & Animals' },
  { code: 'D', label: 'Health Care' },
  { code: 'E', label: 'Mental Health & Crisis Intervention' },
  { code: 'F', label: 'Voluntary Health Associations' },
  { code: 'G', label: 'Human Services' },
  { code: 'H', label: 'International, Foreign Affairs & Development' },
  { code: 'I', label: 'Public, Societal Benefit' },
  { code: 'J', label: 'Religion Related, Spiritual Development' },
  { code: 'K', label: 'Mutual & Membership Benefit' },
  { code: 'L', label: 'Unknown' },
];

const BUDGET_RANGES = [
  { value: '0-250k', label: 'Under $250,000' },
  { value: '250k-1m', label: '$250,000 - $1,000,000' },
  { value: '1m-5m', label: '$1,000,000 - $5,000,000' },
  { value: '5m-10m', label: '$5,000,000 - $10,000,000' },
  { value: '10m-50m', label: '$10,000,000 - $50,000,000' },
  { value: '50m+', label: '$50,000,000+' },
];

interface UserProfile {
  id: string;
  display_name: string | null;
  organization_name: string | null;
  ein: string | null;
  mission_statement: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  ntee_codes: string[] | null;
  budget_range: string | null;
  updated_at: string | null;
}

function UserSettingsContent() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Form state
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [ein, setEin] = useState('');
  const [missionStatement, setMissionStatement] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [county, setCounty] = useState('');
  const [nteeCodes, setNteeCodes] = useState<string[]>([]);
  const [budgetRange, setBudgetRange] = useState('');

  useEffect(() => {
    const loadProfile = async () => {
      if (!user) return;

      try {
        const { data, error: fetchError } = await supabase
          .from('user_profiles')
          .select('*')
          .eq('id', user.id)
          .single();

        if (fetchError && fetchError.code !== 'PGRST116') {
          throw fetchError;
        }

        if (data) {
          setProfile(data);
          setDisplayName(data.display_name || '');
          setOrganizationName(data.organization_name || '');
          setEin(data.ein || '');
          setMissionStatement(data.mission_statement || '');
          setCity(data.city || '');
          setState(data.state || '');
          setCounty(data.county || '');
          setNteeCodes(data.ntee_codes || []);
          setBudgetRange(data.budget_range || '');
        } else {
          // Create a new profile entry
          setProfile({
            id: user.id,
            display_name: null,
            organization_name: null,
            ein: null,
            mission_statement: null,
            city: null,
            state: null,
            county: null,
            ntee_codes: null,
            budget_range: null,
            updated_at: null,
          });
        }
      } catch (err) {
        setError('Failed to load profile');
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    loadProfile();
  }, [user]);

  const handleSave = async () => {
    setError('');
    setSuccess(false);
    setSaving(true);

    try {
      if (!user) {
        setError('User not authenticated');
        setSaving(false);
        return;
      }

      const { error: updateError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: user.id,
            display_name: displayName || null,
            organization_name: organizationName || null,
            ein: ein || null,
            mission_statement: missionStatement || null,
            city: city || null,
            state: state || null,
            county: county || null,
            ntee_codes: nteeCodes.length > 0 ? nteeCodes : null,
            budget_range: budgetRange || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        );

      if (updateError) {
        setError('Failed to save profile: ' + updateError.message);
        setSaving(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError('An unexpected error occurred');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleNteeCode = (code: string) => {
    setNteeCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <Loader className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading profile...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d1117] py-12">
      <div className="max-w-2xl mx-auto px-4">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">Account Settings</h1>
          <p className="text-gray-400">Manage your profile information</p>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-900/20 border border-red-700 rounded-lg flex gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-red-400">{error}</p>
          </div>
        )}

        {/* Success Message */}
        {success && (
          <div className="mb-6 p-4 bg-green-900/20 border border-green-700 rounded-lg flex gap-3">
            <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
            <p className="text-green-400">Profile updated successfully</p>
          </div>
        )}

        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 space-y-6">
          {/* Email Section */}
          <div className="pb-6 border-b border-[#30363d]">
            <h2 className="text-lg font-semibold text-white mb-4">Account</h2>
            <div>
              <label className="block text-sm font-medium text-white mb-2">
                Email address
              </label>
              <input
                type="email"
                value={user?.email || ''}
                disabled
                className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-gray-400 cursor-not-allowed"
              />
              <p className="text-xs text-gray-500 mt-1">
                Contact support to change email
              </p>
            </div>
          </div>

          {/* Organization Profile Section */}
          <div className="pb-6 border-b border-[#30363d]">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              Organization Profile
            </h2>

            <div className="space-y-4">
              <div>
                <label htmlFor="displayName" className="block text-sm font-medium text-white mb-2">
                  Display name
                </label>
                <input
                  id="displayName"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="How you appear in the app"
                  className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label htmlFor="orgName" className="block text-sm font-medium text-white mb-2">
                  Organization name
                </label>
                <input
                  id="orgName"
                  type="text"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="Your nonprofit name"
                  className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="ein" className="block text-sm font-medium text-white mb-2">
                    EIN
                  </label>
                  <input
                    id="ein"
                    type="text"
                    value={ein}
                    onChange={(e) => setEin(e.target.value)}
                    placeholder="12-3456789"
                    className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label htmlFor="budget" className="block text-sm font-medium text-white mb-2">
                    Annual budget range
                  </label>
                  <select
                    id="budget"
                    value={budgetRange}
                    onChange={(e) => setBudgetRange(e.target.value)}
                    className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Select budget range</option>
                    {BUDGET_RANGES.map((range) => (
                      <option key={range.value} value={range.value}>
                        {range.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="mission" className="block text-sm font-medium text-white mb-2">
                  Mission statement
                </label>
                <textarea
                  id="mission"
                  value={missionStatement}
                  onChange={(e) => setMissionStatement(e.target.value)}
                  placeholder="Describe your organization's mission..."
                  rows={3}
                  className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none"
                />
              </div>
            </div>
          </div>

          {/* Location Section */}
          <div className="pb-6 border-b border-[#30363d]">
            <h2 className="text-lg font-semibold text-white mb-4">Location</h2>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label htmlFor="city" className="block text-sm font-medium text-white mb-2">
                  City
                </label>
                <input
                  id="city"
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="City"
                  className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>

              <div>
                <label htmlFor="state" className="block text-sm font-medium text-white mb-2">
                  State
                </label>
                <select
                  id="state"
                  value={state}
                  onChange={(e) => setState(e.target.value)}
                  className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Select</option>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="county" className="block text-sm font-medium text-white mb-2">
                  County
                </label>
                <input
                  id="county"
                  type="text"
                  value={county}
                  onChange={(e) => setCounty(e.target.value)}
                  placeholder="County"
                  className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Focus Areas Section */}
          <div>
            <h2 className="text-lg font-semibold text-white mb-4">Primary focus areas</h2>

            <div className="grid grid-cols-2 gap-2">
              {NTEE_CATEGORIES.map((category) => (
                <label key={category.code} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={nteeCodes.includes(category.code)}
                    onChange={() => toggleNteeCode(category.code)}
                    className="w-4 h-4 rounded bg-[#0d1117] border border-[#30363d] text-blue-600 cursor-pointer"
                  />
                  <span className="text-sm text-gray-300">{category.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="mt-6 flex gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white rounded-lg font-medium transition-colors"
          >
            {saving ? (
              <>
                <Loader className="w-5 h-5 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-5 h-5" />
                Save changes
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function UserSettingsPage() {
  return <UserSettingsContent />;
}
