import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, Building2, AlertCircle, ChevronRight, ChevronLeft, Loader, CheckCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

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

type SignupStep = 'account' | 'profile' | 'review';



export default function SignupPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [currentStep, setCurrentStep] = useState<SignupStep>('account');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Account data
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Profile data
  const [organizationName, setOrganizationName] = useState('');
  const [ein, setEin] = useState('');
  const [missionStatement, setMissionStatement] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [nteeCodes, setNteeCodes] = useState<string[]>([]);
  const [budgetRange, setBudgetRange] = useState('');

  // Redirect if already authenticated
  useEffect(() => {
    if (user) {
      navigate('/dashboard');
    }
  }, [user, navigate]);

  const validateAccountStep = () => {
    if (!email.trim()) {
      setError('Email is required');
      return false;
    }
    if (!email.includes('@')) {
      setError('Please enter a valid email address');
      return false;
    }
    if (!password.trim()) {
      setError('Password is required');
      return false;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return false;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return false;
    }
    return true;
  };

  const validateProfileStep = () => {
    if (!organizationName.trim()) {
      setError('Organization name is required');
      return false;
    }
    if (!city.trim()) {
      setError('City is required');
      return false;
    }
    if (!state) {
      setError('State is required');
      return false;
    }
    if (nteeCodes.length === 0) {
      setError('Please select at least one focus area');
      return false;
    }
    if (!budgetRange) {
      setError('Please select a budget range');
      return false;
    }
    return true;
  };

  const handleNextStep = () => {
    setError('');

    if (currentStep === 'account') {
      if (!validateAccountStep()) return;
      setCurrentStep('profile');
    } else if (currentStep === 'profile') {
      if (!validateProfileStep()) return;
      setCurrentStep('review');
    }
  };

  const handlePrevStep = () => {
    setError('');
    if (currentStep === 'profile') {
      setCurrentStep('account');
    } else if (currentStep === 'review') {
      setCurrentStep('profile');
    }
  };

  const handleCompleteSignup = async () => {
    setError('');
    setLoading(true);

    try {
      // Create auth account
      const { data: authData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (signUpError) {
        setError(signUpError.message);
        setLoading(false);
        return;
      }

      if (!authData.user) {
        setError('Failed to create account');
        setLoading(false);
        return;
      }

      // Upsert user profile
      const { error: profileError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: authData.user.id,
            display_name: organizationName,
            organization_name: organizationName,
            ein: ein || null,
            mission_statement: missionStatement || null,
            city,
            state,
            ntee_codes: nteeCodes,
            budget_range: budgetRange,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        );

      if (profileError) {
        setError('Failed to save profile: ' + profileError.message);
        setLoading(false);
        return;
      }

      // Redirect to dashboard or email verification page
      const redirectUrl = sessionStorage.getItem('authRedirect') || '/dashboard';
      sessionStorage.removeItem('authRedirect');
      navigate(redirectUrl);
    } catch (err) {
      setError('An unexpected error occurred during signup');
      setLoading(false);
    }
  };

  const toggleNteeCode = (code: string) => {
    setNteeCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Create your account</h1>
            <p className="text-gray-400">Step {currentStep === 'account' ? '1' : currentStep === 'profile' ? '2' : '3'} of 3</p>
          </div>

          {/* Progress Bar */}
          <div className="mb-8 flex gap-2">
            <div className={`h-1 flex-1 rounded-full ${currentStep === 'account' ? 'bg-blue-500' : 'bg-[#30363d]'}`}></div>
            <div className={`h-1 flex-1 rounded-full ${['profile', 'review'].includes(currentStep) ? 'bg-blue-500' : 'bg-[#30363d]'}`}></div>
            <div className={`h-1 flex-1 rounded-full ${currentStep === 'review' ? 'bg-blue-500' : 'bg-[#30363d]'}`}></div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 p-4 bg-red-900/20 border border-red-700 rounded-lg flex gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Step 1: Account Creation */}
          {currentStep === 'account' && (
            <div className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-white mb-2">
                  Email address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full pl-10 pr-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-white mb-2">
                  Password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-10 pr-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">At least 8 characters</p>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-white mb-2">
                  Confirm password
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                  <input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-10 pr-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Organization Profile */}
          {currentStep === 'profile' && (
            <div className="space-y-4">
              <div>
                <label htmlFor="orgName" className="block text-sm font-medium text-white mb-2">
                  Organization name *
                </label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-3 w-5 h-5 text-gray-500" />
                  <input
                    id="orgName"
                    type="text"
                    value={organizationName}
                    onChange={(e) => setOrganizationName(e.target.value)}
                    placeholder="Your nonprofit name"
                    className="w-full pl-10 pr-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="ein" className="block text-sm font-medium text-white mb-2">
                  EIN (Optional)
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
                <label htmlFor="mission" className="block text-sm font-medium text-white mb-2">
                  Mission statement (Optional)
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

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="city" className="block text-sm font-medium text-white mb-2">
                    City *
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
                    State *
                  </label>
                  <select
                    id="state"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  >
                    <option value="">Select a state</option>
                    {US_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-white mb-3">
                  Primary focus areas *
                </label>
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

              <div>
                <label htmlFor="budget" className="block text-sm font-medium text-white mb-2">
                  Annual budget range *
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
          )}

          {/* Step 3: Review */}
          {currentStep === 'review' && (
            <div className="space-y-4">
              <div className="bg-[#0d1117] rounded-lg p-4 space-y-4">
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase">Email</p>
                  <p className="text-white mt-1">{email}</p>
                </div>

                <div className="border-t border-[#30363d]"></div>

                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase">Organization</p>
                  <p className="text-white mt-1">{organizationName}</p>
                </div>

                {ein && (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase">EIN</p>
                    <p className="text-white mt-1">{ein}</p>
                  </div>
                )}

                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase">Location</p>
                  <p className="text-white mt-1">{city}, {state}</p>
                </div>

                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase">Focus areas</p>
                  <p className="text-white mt-1">
                    {nteeCodes.map((code) => NTEE_CATEGORIES.find((c) => c.code === code)?.label).join(', ')}
                  </p>
                </div>

                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase">Budget range</p>
                  <p className="text-white mt-1">
                    {BUDGET_RANGES.find((r) => r.value === budgetRange)?.label}
                  </p>
                </div>
              </div>

              <p className="text-sm text-gray-400 text-center">
                By signing up, you agree to our Terms of Service
              </p>
            </div>
          )}

          {/* Navigation */}
          <div className="mt-8 flex gap-3">
            {currentStep !== 'account' && (
              <button
                onClick={handlePrevStep}
                disabled={loading}
                className="flex items-center justify-center gap-2 px-6 py-2 bg-[#0d1117] border border-[#30363d] text-white rounded-lg hover:bg-[#1a202e] disabled:opacity-50 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
            )}

            {currentStep !== 'review' && (
              <button
                onClick={handleNextStep}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white rounded-lg font-medium transition-colors"
              >
                Continue
                <ChevronRight className="w-4 h-4" />
              </button>
            )}

            {currentStep === 'review' && (
              <button
                onClick={handleCompleteSignup}
                disabled={loading}
                className="flex-1 flex items-center justify-center gap-2 px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-600/50 text-white rounded-lg font-medium transition-colors"
              >
                {loading ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" />
                    Creating account...
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    Complete signup
                  </>
                )}
              </button>
            )}
          </div>

          {/* Login Link */}
          <div className="mt-6 text-center">
            <p className="text-gray-400 text-sm">
              Already have an account?{' '}
              <Link to="/login" className="text-blue-400 hover:text-blue-300 font-medium transition-colors">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
