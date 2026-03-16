import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders } from '../lib/supabase';
import { CheckCircle, ArrowRight, ArrowLeft, User, FolderPlus, Search, Bookmark, Sparkles } from 'lucide-react';

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
      navigate('/dashboard');
    } catch (err) {
      console.error('Error skipping:', err);
    }
  };

  const handleStepAction = () => {
    switch (currentStep) {
      case 2: navigate('/settings'); break;
      case 3: navigate('/projects/new'); break;
      case 4: navigate('/search'); break;
      case 5: navigate('/dashboard'); break;
    }
  };

  if (loading || isLoading) return (
    <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
      <div className="text-gray-400">Loading...</div>
    </div>
  );

  const step = STEPS[currentStep - 1];

  return (
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

          {currentStep > 1 && (
            <button onClick={handleStepAction}
              className="mb-6 px-6 py-3 bg-[#161b22] border border-[#30363d] hover:border-blue-500 rounded-lg text-sm transition-colors w-full text-left">
              <p className="text-white font-medium">
                {currentStep === 2 ? 'Go to Profile Settings' :
                 currentStep === 3 ? 'Create Your First Project' :
                 currentStep === 4 ? 'Search for Funders' :
                 'Go to Dashboard'}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">You can always come back to continue setup</p>
            </button>
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
  );
}
