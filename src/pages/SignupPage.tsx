import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Lock, Building2, AlertCircle, ChevronRight, ChevronLeft, Loader, CheckCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import NavBar from '../components/NavBar';

const SSO_PROVIDERS = [
  {
    key: 'google' as const,
    label: 'Sign up with Google',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
      </svg>
    ),
  },
  {
    key: 'linkedin' as const,
    label: 'Sign up with LinkedIn',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="#0A66C2" aria-hidden="true">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
      </svg>
    ),
  },
  {
    key: 'microsoft' as const,
    label: 'Sign up with Microsoft',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
        <path d="M11.4 2H2v9.4h9.4V2z" fill="#F25022" />
        <path d="M22 2h-9.4v9.4H22V2z" fill="#7FBA00" />
        <path d="M11.4 12.6H2V22h9.4v-9.4z" fill="#00A4EF" />
        <path d="M22 12.6h-9.4V22H22v-9.4z" fill="#FFB900" />
      </svg>
    ),
  },
] as const;

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
  const { user, signInWithGoogle, signInWithLinkedIn, signInWithMicrosoft } = useAuth();
  const [currentStep, setCurrentStep] = useState<SignupStep>('account');
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
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

  const handleOAuth = async (key: 'google' | 'linkedin' | 'microsoft') => {
    setError('');
    setLoadingProvider(key);
    try {
      if (key === 'google') await signInWithGoogle();
      else if (key === 'linkedin') await signInWithLinkedIn();
      else await signInWithMicrosoft();
    } catch {
      setError('Something went wrong. Please try again.');
      setLoadingProvider(null);
    }
  };

  const toggleNteeCode = (code: string) => {
    setNteeCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  return (
    <>
    <NavBar />
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Create your account</h1>
            <p className="text-gray-400">Step {currentStep === 'account' ? '1' : currentStep === 'profile' ? '2' : '3'} of 3</p>
          </div>

          {/* SSO Buttons — only show on account step */}
          {currentStep === 'account' && (
            <>
              <div className="space-y-3 mb-6">
                {SSO_PROVIDERS.map(({ key, label, icon }) => (
                  <button
                    key={key}
                    onClick={() => handleOAuth(key)}
                    disabled={loadingProvider !== null || loading}
                    className="w-full flex items-center justify-center gap-3 bg-white text-gray-900 font-medium rounded-xl px-4 py-3 text-sm hover:bg-gray-100 transition-colors disabled:opacity-60"
                  >
                    {loadingProvider === key ? <Loader className="w-5 h-5 animate-spin" /> : icon}
                    {label}
                  </button>
                ))}
              </div>
              <div className="relative mb-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[#30363d]" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-[#161b22] text-gray-400">Or sign up with email</span>
                </div>
              </div>
            </>
          )}

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
    </>
  );
}
