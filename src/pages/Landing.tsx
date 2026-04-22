import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Target, Zap, Bookmark, PenLine } from 'lucide-react';
import DemoVideo from '../components/DemoVideo';
import NavBar from '../components/NavBar';
import Footer from '../components/Footer';

export default function Landing() {
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'Non-Profit Funder Finder — Free AI Funder Matching for 501(c)(3)s';
  }, []);

  return (
    <div className="min-h-screen bg-[#0d1117] text-white flex flex-col">
      <NavBar />

      {/* Hero */}
      <div id="main-content" className="flex flex-col items-center justify-center text-center px-6 pt-24 pb-12">
        <h1 className="text-5xl md:text-7xl font-bold leading-tight tracking-tight max-w-4xl">
          Find Funders Aligned to Your Mission
        </h1>
        <p className="mt-6 text-lg md:text-xl text-gray-400 max-w-2xl">
          Connect with foundations, DAFs, and corporate giving programs that match your
          nonprofit's mission in seconds.
        </p>
        <button
          onClick={() => navigate('/mission')}
          className="mt-8 inline-flex items-center gap-3 bg-white text-gray-900 rounded-2xl px-10 py-4 text-lg font-semibold hover:bg-gray-100 transition shadow-lg"
        >
          <Search size={22} />
          Get Started
        </button>
        <p className="mt-4 text-base text-gray-400">
          No account required &middot; No credit card &middot; Results in 30 seconds
        </p>
      </div>

      {/* Demo Video */}
      <div className="max-w-[90rem] mx-auto">
        <p className="text-center text-sm text-gray-500 uppercase tracking-widest mb-4">See It in Action</p>
        <DemoVideo />
      </div>

      {/* How It Works */}
      <div className="px-6 pb-20 max-w-5xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">How It Works</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
              {
                icon: <Target size={32} className="text-blue-400" />,
                step: '1. Describe Your Mission',
                desc: 'Enter your mission statement and the location you serve. Our AI finds the best-fit funders in seconds.',
              },
            {
              icon: <Zap size={32} className="text-green-400" />,
              step: '2. Get Ranked Matches',
              desc: 'Receive a scored list of foundations, DAFs, and corporate giving programs aligned to your focus areas.',
            },
            {
              icon: <Bookmark size={32} className="text-purple-400" />,
              step: '3. Save & Track',
              desc: 'Save funders to your pipeline, set statuses like Researching or Applied, and manage your outreach.',
            },
            {
              icon: <PenLine size={32} className="text-amber-400" />,
              step: '4. AI Grant Writer',
              desc: 'Generate a personalized grant application draft with a funder-fit score and compliance checklist.',
            },
          ].map(({ icon, step, desc }) => (
            <div key={step} className="bg-[#161b22] border border-[#30363d] rounded-2xl p-8 text-center">
              <div className="flex justify-center mb-4">
                <div className="bg-[#21262d] rounded-full p-4">{icon}</div>
              </div>
              <h3 className="text-xl font-semibold mb-3">{step}</h3>
              <p className="text-gray-400">{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* What's Included */}
      <div className="px-6 pb-24 max-w-5xl mx-auto">
        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-12">
          <h2 className="text-3xl font-bold text-center mb-10">What's Included</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-y-6 gap-x-12">
            {[
              'Mission alignment scores for every funder',
              'AI-generated grant application drafts',
              'Pipeline tracking with custom statuses',
              'Save, organize, and manage your funder list',
              'Foundations, DAFs, and corporate giving programs',
              'No account required to start searching',
            ].map(item => (
              <div key={item} className="flex items-start gap-3">
                <span className="text-green-400 mt-0.5 font-bold text-lg">✓</span>
                <span className="text-gray-200">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="text-center pb-24 px-6">
        <h2 className="text-3xl font-bold mb-4">Ready to find your funders?</h2>
        <p className="text-gray-400 mb-8 max-w-xl mx-auto">
          Join hundreds of nonprofits using FunderMatch to connect with aligned funders.
        </p>
        <button
          onClick={() => navigate('/mission')}
          className="inline-flex items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl px-10 py-4 text-lg font-semibold transition"
        >
          <Search size={22} />
          Find Funders Now
        </button>
      </div>

      <Footer />
    </div>
  );
}
