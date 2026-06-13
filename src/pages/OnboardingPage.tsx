import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { supabase, getEdgeFunctionHeaders } from '../lib/supabase';
import { ArrowRight, ArrowLeft, User, FolderPlus, Search, Bookmark, Sparkles } from 'lucide-react';
import NavBar from '../components/NavBar';
import OnboardingAdvisor from '../components/OnboardingAdvisor';
import type { OrgProfile } from '../lib/onboardingAdvisor';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const ONBOARDING_URL = `${SUPABASE_URL}/functions/v1/onboarding`;

const STEPS = [
  { num: 1, title: 'Welcome', icon: <Sparkles size={24} />, description: 'Welcome to FunderMatch! Let\'s get you set up in a few quick steps.' },
  { num: 2, title: 'Your Profile', icon: <User size={24} />, description: 'Tell us about your organization so we can find the best funders for you.' },
  { num: 3, title: 'First Project', icon: <FolderPlus size={24} />, description: 'Create your first funding project to start tracking grant opportunities.' },
  { num: 4, title: 'Find Matches', icon: <Search size={24} />, description: 'Discover funders that align with your mission and programs.' },
  { num: 5, title: 'Save & Track', icon: <Bookmark size={24} />, description: 'Save promising funders to your tracker and start managing your pipeline.' },
];

export default function OnboardingPage() {
  useEffect(() => {
    document.title = 'Welcome to FunderMatch';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Set up your nonprofit profile to get personalized funder matches.';
  }, []);

  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // FM-IC-ONB-003: capture county-level location + plain-language fields of
  // work in the onboarding tutorial. These previously had placeholder
  // inputs that weren't wired anywhere, so the audit graded ONB-003
  // PARTIAL ("county-level granularity not enforced"). The save_profile
  // action on the onboarding edge function persists them to
  // public.user_profiles.
  const [orgName, setOrgName] = useState('');
  const [missionStatement, setMissionStatement] = useState('');
  const [city, setCity] = useState('');
  const [stateAbbr, setStateAbbr] = useState('');
  const [county, setCounty] = useState('');
  const [orgType, setOrgType] = useState('');
  const [fieldsOfWork, setFieldsOfWork] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Step 3: project creation state
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [targetFunding, setTargetFunding] = useState('');
  const [focusArea, setFocusArea] = useState('');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [isCreatingProject, setIsCreatingProject] = useState(false);

  const FIELDS_OF_WORK_OPTIONS: string[] = [
    'Arts & Culture',
    'Civic Engagement',
    'Community Development',
    'Disability Services',
    'Education',
    'Environment',
    'Food Security',
    'Health',
    'Housing',
    'Human Services',
    'Immigrant Services',
    'Mental Health',
    'Public Safety',
    'Racial Equity',
    'Research',
    'Veterans',
    'Workforce Development',
    'Youth Development',
  ];

  const toggleFieldOfWork = (label: string) => {
    setFieldsOfWork((prev) =>
      prev.includes(label) ? prev.filter((v) => v !== label) : [...prev, label],
    );
  };


  useEffect(() => {
    if (!loading && user) loadProgress();
  }, [user, loading]);

  const loadProgress = async () => {
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(ONBOARDING_URL, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.completed_at || data.skipped) {
          navigate('/dashboard');
          return;
        }
        setCurrentStep(data.current_step || 1);
        setCompletedSteps(data.completed_steps || []);
      }
    } catch (err) {
      console.error('Error loading onboarding:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // FM-IC-ONB-003: persist Step 2 profile via the onboarding edge function.
  const saveProfile = async (): Promise<boolean> => {
    setSaveError(null);
    setIsSaving(true);
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(ONBOARDING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          action: 'save_profile',
          profile: {
            organization_name: orgName,
            mission_statement: missionStatement,
            city,
            state: stateAbbr,
            county,
            org_type: orgType,
            fields_of_work: fieldsOfWork,
          },
        }),
      });
      if (!res.ok) {
        let msg = 'Could not save profile';
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
        setSaveError(msg);
        return false;
      }
      return true;
    } catch (err: any) {
      console.error('Error saving profile:', err);
      setSaveError(err?.message || 'Could not save profile');
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Create a project row in public.projects from the Step 3 form, then
   * record the project ID on onboarding_progress.first_project_id so the
   * rest of the onboarding flow (and the dashboard) can reference it.
   */
  const createProject = async (): Promise<boolean> => {
    setProjectError(null);
    setIsCreatingProject(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const activeUser = sessionData.session?.user;
      if (!activeUser) {
        setProjectError('Your session has expired. Please sign in again.');
        return false;
      }

      // Parse targetFunding into an integer (strip non-numeric chars)
      const parsedBudget = targetFunding
        ? parseInt(targetFunding.replace(/[^0-9]/g, ''), 10) || null
        : null;

      const { data, error: insertError } = await supabase
        .from('projects')
        .insert({
          user_id: activeUser.id,
          name: projectName.trim(),
          description: projectDescription.trim() || null,
          fields_of_work: focusArea ? [focusArea] : null,
          budget_min: parsedBudget,
          budget_max: parsedBudget,
          is_default: true,
        })
        .select('id')
        .single();

      if (insertError) throw insertError;

      // Record the project on onboarding_progress so the dashboard knows
      // the user created their first project during onboarding.
      try {
        const headers = await getEdgeFunctionHeaders();
        await fetch(ONBOARDING_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ first_project_id: data.id }),
        });
      } catch (progressErr) {
        // Non-blocking — the project was already created successfully.
        console.warn('Could not update onboarding progress with project ID:', progressErr);
      }

      return true;
    } catch (err: any) {
      console.error('Error creating project:', err);
      const msg = err?.message || 'Could not create project';
      setProjectError(msg);
      return false;
    } finally {
      setIsCreatingProject(false);
    }
  };

  const saveProgress = async (step: number, completed: number[]) => {
    try {
      const headers = await getEdgeFunctionHeaders();
      await fetch(ONBOARDING_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ current_step: step, completed_steps: completed }),
      });
    } catch (err) {
      console.error('Error saving progress:', err);
    }
  };

  const handleNext = async () => {
    // FM-IC-ONB-003: when leaving Step 2 (profile), persist what the user
    // entered so the data is captured even if they bounce out of the
    // tutorial. Skip the save quietly if every field is blank.
    if (currentStep === 2) {
      const anyProfileField = !!(
        orgName || missionStatement || city || stateAbbr || county || orgType || fieldsOfWork.length
      );
      if (anyProfileField) {
        const ok = await saveProfile();
        if (!ok) return; // surface the error to the user and stay on step
      }
    }

    // Step 3: create the project before advancing
    if (currentStep === 3) {
      if (!projectName.trim()) {
        setProjectError('Project name is required.');
        return;
      }
      const ok = await createProject();
      if (!ok) return; // stay on step so the user can see the error
    }

    const newCompleted = [...completedSteps, currentStep].filter((v, i, a) => a.indexOf(v) === i);
    setCompletedSteps(newCompleted);

    if (currentStep >= 5) {
      // Complete onboarding
      await saveProgress(5, newCompleted);
      localStorage.setItem('onboarding_complete', 'true');
      navigate('/dashboard');
      return;
    }

    const nextStep = currentStep + 1;
    setCurrentStep(nextStep);
    await saveProgress(nextStep, newCompleted);
  };

  const handleBack = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  const handleSkip = async () => {
    try {
      const headers = await getEdgeFunctionHeaders();
      await fetch(ONBOARDING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ action: 'skip' }),
      });
      localStorage.setItem('onboarding_complete', 'true');
      navigate('/dashboard');
    } catch (err) {
      console.error('Error skipping:', err);
    }
  };

  // Build the org profile from form state so the advisor has current context.
  // NOTE: useMemo MUST be called before any conditional return (Rules of Hooks).
  // Previously this was called after the loading early-return, which triggered
  // React error #310 ("Rendered more hooks than during the previous render")
  // when a freshly-signed-up user first reached this page, because on the first
  // render isLoading was true (returning early) and on the second render the
  // hook count changed. See FunderMatch bug: "Issue when first creating an
  // account and going to the Dashboard page".
  const advisorProfile: OrgProfile = useMemo(() => ({
    organization_name: orgName || undefined,
    mission_statement: missionStatement || undefined,
    city: city || undefined,
    state: stateAbbr || undefined,
    county: county || undefined,
    org_type: orgType || undefined,
    fields_of_work: fieldsOfWork.length > 0 ? fieldsOfWork : undefined,
  }), [orgName, missionStatement, city, stateAbbr, county, orgType, fieldsOfWork]);

  if (loading || isLoading) return (
    <>
      <NavBar />
      <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    </>
  );

  const step = STEPS[currentStep - 1];

  // Map the 1-based onboarding step to the 0-based advisor step.
  // Steps 1-2 map to advisor steps 0-1; steps 3-5 map to 2-3.
  const advisorStep = Math.min(currentStep - 1, 3) as 0 | 1 | 2 | 3;

  const handleAdvisorCreateProject = () => {
    // Jump to step 3 (First Project) if not already there
    if (currentStep < 3) {
      setCurrentStep(3);
    }
  };

  return (
    <>
      <NavBar />
      <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
      {/* Progress bar */}
      <div className="border-b border-[#30363d] bg-[#161b22]">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-blue-400">FunderMatch</h1>
            <button onClick={handleSkip} className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
              Skip Onboarding
            </button>
          </div>
          <div className="flex gap-1">
            {STEPS.map(s => (
              <div key={s.num} className={`flex-1 h-1.5 rounded-full transition-colors ${
                completedSteps.includes(s.num) ? 'bg-green-500' :
                s.num === currentStep ? 'bg-blue-500' : 'bg-[#30363d]'
              }`} />
            ))}
          </div>
          <div className="flex justify-between mt-2">
            {STEPS.map(s => (
              <p key={s.num} className={`text-[10px] ${s.num === currentStep ? 'text-blue-400' : 'text-gray-600'}`}>
                {s.title}
              </p>
            ))}
          </div>
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center">
          <div className={`w-16 h-16 mx-auto mb-6 rounded-2xl flex items-center justify-center ${
            currentStep === 1 ? 'bg-blue-600' : 'bg-[#161b22] border border-[#30363d]'
          }`}>
            {step.icon}
          </div>

          <h2 className="text-2xl font-bold mb-3">
            {currentStep === 1 ? `Welcome to FunderMatch!` : `Step ${currentStep}: ${step.title}`}
          </h2>
          <p className="text-gray-400 mb-8 leading-relaxed">{step.description}</p>

          {currentStep === 1 && (
            <div className="text-left bg-[#161b22] border border-[#30363d] rounded-lg p-4 mb-8">
              <p className="text-sm text-gray-300 mb-3">In the next few steps, you'll:</p>
              {STEPS.slice(1).map(s => (
                <div key={s.num} className="flex items-center gap-3 py-1.5">
                  <span className="w-5 h-5 bg-[#30363d] rounded-full text-[10px] flex items-center justify-center text-gray-400">{s.num}</span>
                  <span className="text-sm text-gray-400">{s.title}: {s.description.split('.')[0]}</span>
                </div>
              ))}
            </div>
          )}

          {currentStep === 2 && (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 mb-6 text-left space-y-4">
              <p className="text-sm font-semibold text-white">Organization Profile</p>
              <input type="text" placeholder="Organization name" aria-label="Organization name"
                value={orgName} onChange={(e) => setOrgName(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              <input type="text" placeholder="Mission statement" aria-label="Mission statement"
                value={missionStatement} onChange={(e) => setMissionStatement(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              <div className="grid grid-cols-3 gap-3">
                <input type="text" placeholder="City" aria-label="City"
                  value={city} onChange={(e) => setCity(e.target.value)}
                  className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                <input type="text" placeholder="County" aria-label="County"
                  value={county} onChange={(e) => setCounty(e.target.value)}
                  className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                <input type="text" placeholder="State" aria-label="State" maxLength={2}
                  value={stateAbbr} onChange={(e) => setStateAbbr(e.target.value.toUpperCase())}
                  className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <p className="text-[11px] text-gray-500 -mt-2">
                County-level location helps us match you to local funders that fund specifically in your area (FM-IC-ONB-003).
              </p>
              <select aria-label="Organization type"
                value={orgType} onChange={(e) => setOrgType(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm">
                <option value="">Select organization type...</option>
                <option value="501c3">501(c)(3) Public Charity</option>
                <option value="501c4">501(c)(4) Social Welfare</option>
                <option value="foundation">Private Foundation</option>
                <option value="fiscal">Fiscal Sponsorship</option>
              </select>
              <div>
                <p className="text-xs font-medium text-gray-300 mb-2">Fields of work <span className="text-gray-500 font-normal">(plain-language, pick any that apply)</span></p>
                <div className="flex flex-wrap gap-2">
                  {FIELDS_OF_WORK_OPTIONS.map((label) => {
                    const selected = fieldsOfWork.includes(label);
                    return (
                      <button type="button" key={label}
                        onClick={() => toggleFieldOfWork(label)}
                        aria-pressed={selected}
                        className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                          selected
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'bg-[#0d1117] border-[#30363d] text-gray-300 hover:border-blue-400'
                        }`}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {saveError && (
                <p role="alert" className="text-xs text-red-400">{saveError}</p>
              )}
              {isSaving && (
                <p className="text-xs text-gray-500">Saving your profile...</p>
              )}
              <p className="text-xs text-gray-500">This info helps us match you with relevant funders. You can update it later in Settings.</p>
            </div>
          )}

          {currentStep === 3 && (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 mb-6 text-left space-y-4">
              <p className="text-sm font-semibold text-white">Create Your First Project</p>
              <input type="text" placeholder="Project name (e.g., Youth STEM Education Program)"
                aria-label="Project name"
                value={projectName}
                onChange={(e) => { setProjectName(e.target.value); setProjectError(null); }}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              <textarea placeholder="Brief project description — what does it do and who does it serve?"
                aria-label="Project description"
                rows={3}
                value={projectDescription}
                onChange={(e) => setProjectDescription(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 resize-none" />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Target funding</label>
                  <input type="text" placeholder="$50,000"
                    aria-label="Target funding"
                    value={targetFunding}
                    onChange={(e) => setTargetFunding(e.target.value)}
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Focus area</label>
                  <select
                    aria-label="Focus area"
                    value={focusArea}
                    onChange={(e) => setFocusArea(e.target.value)}
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm">
                    <option value="">Select...</option>
                    <option value="Education">Education</option>
                    <option value="Health">Health</option>
                    <option value="Environment">Environment</option>
                    <option value="Arts & Culture">Arts & Culture</option>
                    <option value="Community Development">Community Development</option>
                    <option value="Human Services">Human Services</option>
                  </select>
                </div>
              </div>
              {projectError && (
                <p role="alert" className="text-xs text-red-400">{projectError}</p>
              )}
              {isCreatingProject && (
                <p className="text-xs text-gray-500">Creating your project...</p>
              )}
              <p className="text-xs text-gray-500">We'll use this to find funders that match your project's mission.</p>
            </div>
          )}

          {currentStep === 4 && (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 mb-6 text-left space-y-4">
              <p className="text-sm font-semibold text-white">Review Your Top Matches</p>
              <p className="text-xs text-gray-500 mb-2">Based on your project, here are example funders our AI would find for you:</p>
              {[
                { name: 'Community Foundation', type: 'Foundation', match: '95%', focus: 'Education & Youth' },
                { name: 'Regional Health Trust', type: 'Trust', match: '88%', focus: 'Community Health' },
                { name: 'National Arts Council', type: 'Government', match: '82%', focus: 'Arts & Culture' },
              ].map(funder => (
                <div key={funder.name} className="flex items-center justify-between p-3 bg-[#0d1117] rounded-lg">
                  <div>
                    <p className="text-sm text-white font-medium">{funder.name}</p>
                    <p className="text-xs text-gray-500">{funder.type} · {funder.focus}</p>
                  </div>
                  <span className="text-sm font-bold text-green-400">{funder.match}</span>
                </div>
              ))}
              <p className="text-xs text-gray-500">After setup, you'll see real matches based on your organization's data.</p>
            </div>
          )}

          {currentStep === 5 && (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 mb-6 text-left space-y-3">
              <p className="text-sm font-semibold text-white">You're All Set!</p>
              <div className="space-y-2">
                {[
                  'Track funders in your personalized pipeline',
                  'Set deadlines and get automated reminders',
                  'Generate AI-powered grant proposals',
                  'Invite team members to collaborate',
                  'Export reports and share progress',
                ].map(tip => (
                  <div key={tip} className="flex items-center gap-2 text-sm text-gray-400">
                    <span className="w-1.5 h-1.5 bg-green-500 rounded-full flex-shrink-0" />
                    {tip}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <button onClick={handleBack} disabled={currentStep === 1}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-white disabled:opacity-30 transition-colors">
              <ArrowLeft size={16} /> Back
            </button>
            <button onClick={handleNext}
              disabled={isCreatingProject || isSaving}
              className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {isCreatingProject ? 'Creating...' : currentStep >= 5 ? 'Finish Setup' : 'Continue'} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>

      {/* AI Grant Strategy Advisor — collapsible chat panel */}
      <OnboardingAdvisor
        step={advisorStep}
        profile={advisorProfile}
        onCreateProject={handleAdvisorCreateProject}
      />
    </>
  );
}
