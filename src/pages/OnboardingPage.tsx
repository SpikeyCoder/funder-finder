import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders } from '../lib/supabase';
import { ArrowRight, ArrowLeft, User, FolderPlus, Search, Bookmark, Sparkles } from 'lucide-react';
import NavBar from '../components/NavBar';

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
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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

  if (loading || isLoading) return (
    <>
      <NavBar />
      <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    </>
  );

  const step = STEPS[currentStep - 1];

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
              <input type="text" placeholder="Organization name"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              <input type="text" placeholder="Mission statement"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              <div className="grid grid-cols-2 gap-3">
                <input type="text" placeholder="City"
                  className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                <input type="text" placeholder="State"
                  className="bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <select className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm">
                <option value="">Select organization type...</option>
                <option value="501c3">501(c)(3) Public Charity</option>
                <option value="501c4">501(c)(4) Social Welfare</option>
                <option value="foundation">Private Foundation</option>
                <option value="fiscal">Fiscal Sponsorship</option>
              </select>
              <p className="text-xs text-gray-500">This info helps us match you with relevant funders. You can update it later in Settings.</p>
            </div>
          )}

          {currentStep === 3 && (
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5 mb-6 text-left space-y-4">
              <p className="text-sm font-semibold text-white">Create Your First Project</p>
              <input type="text" placeholder="Project name (e.g., Youth STEM Education Program)"
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              <textarea placeholder="Brief project description — what does it do and who does it serve?"
                rows={3}
                className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 resize-none" />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Target funding</label>
                  <input type="text" placeholder="$50,000"
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 mb-1 block">Focus area</label>
                  <select className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm">
                    <option value="">Select...</option>
                    <option>Education</option>
                    <option>Health</option>
                    <option>Environment</option>
                    <option>Arts & Culture</option>
                    <option>Community Development</option>
                    <option>Human Services</option>
                  </select>
                </div>
              </div>
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
              className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors">
              {currentStep >= 5 ? 'Finish Setup' : 'Continue'} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
