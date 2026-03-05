import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Target, Zap, Bookmark } from 'lucide-react';
import DemoVideo from '../components/DemoVideo';

export default function Landing() {
  const navigate = useNavigate();

  useEffect(() => {
    document.title = 'Non-Profit Funder Finder — Free AI Funder Matching for 501(c)(3)s';
    const desc = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (desc) desc.content = 'Find foundations, DAFs, and corporate giving programs aligned to your nonprofit\u2019s mission in seconds. Free AI-powered funder matching \u2014 no account required.';
  }, []);

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      {/* Hero */}
      <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
        <h1 className="text-5xl font-bold mb-6 leading-tight max-w-3xl">
          Find Funders Aligned to Your Mission
        </h1>
        <p className="text-lg text-gray-400 mb-10 max-w-xl">
          Connect with foundations, DAFs, and corporate giving programs that match your nonprofit's mission in seconds.
        </p>
        <button
          onClick={() => navigate('/mission')}
          className="flex items-center gap-3 bg-white text-gray-900 font-semibold px-8 py-4 rounded-xl text-lg hover:bg-gray-100 transition-colors"
        >
          <Search size={20} />
          Get Started
        </button>
        <p className="text-sm text-gray-400 mt-4">
          No account required &middot; No credit card &middot; Results in 30 seconds
        </p>
      </div>

      {/* Demo animation */}
      <div className="max-w-5xl mx-auto px-4 pb-6">
        <p className="text-center text-gray-400 text-sm mb-2 tracking-wide uppercase font-medium">See it in action</p>
        <DemoVideo />
      </div>

      {/* How It Works */}
      <div className="px-6 pb-20 max-w-5xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">How It Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
              {
                icon: <Target size={32} className="text-blue-400" />,
                step: '1. Enter Your Mission',
                desc: "Describe your mission and add optional exclusion keywords (for example: early childhood education, adult literacy).",
              },
            {
              icon: <Zap size={32} className="text-green-400" />,
              step: '2. Get Instant Matches',
              desc: "Receive a ranked list of funders most aligned with your organization's focus areas.",
            },
            {
              icon: <Bookmark size={32} className="text-purple-400" />,
              step: '3. Access Contact Info',
              desc: 'View funder details, save favorites, and export contact information for outreach.',
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
              'Direct contact information for decision makers',
              'Mission alignment tags and scores',
              'Recommended next steps for each funder',
              'Save and export your funder list',
              'Foundations, DAFs, and corporate giving programs',
              'Fast, friction-free experience',
            ].map(item => (
              <div key={item} className="flex items-start gap-3">
                <span className="text-green-400 mt-0.5 font-bold text-lg">✓</span>
                <span className="text-gray-200">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>


    </div>
  );
}
