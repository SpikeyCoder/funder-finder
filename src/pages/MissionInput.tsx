import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Sparkles, X, Plus } from 'lucide-react';

const SUGGESTED_KEYWORDS = [
  'education', 'health', 'equity', 'environment', 'climate', 'children',
  'community', 'technology', 'arts', 'justice', 'democracy', 'workforce',
  'poverty', 'innovation', 'culture',
];

const EXAMPLES = [
  'We empower underserved youth through accessible education programs and mentorship opportunities that build skills for future success.',
  'Our organization provides mental health services to low-income families in rural communities, reducing barriers to care.',
  'We protect and restore natural ecosystems by engaging local communities in environmental stewardship and advocacy.',
];

export default function MissionInput() {
  const navigate = useNavigate();
  const [mission, setMission] = useState('');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState('');
  const [error, setError] = useState('');
  const [showExamples, setShowExamples] = useState(false);

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
    if (!mission.trim()) {
      setError('Please enter your mission statement to continue.');
      return;
    }
    navigate('/results', { state: { mission, keywords } });
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
            onChange={e => { setMission(e.target.value); setError(''); }}
            placeholder="Example: We empower underserved youth through accessible education programs and mentorship opportunities that build skills for future success."
            rows={4}
            className={`w-full bg-[#0d1117] border rounded-xl px-4 py-3 text-white placeholder-gray-600 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 ${error ? 'border-red-500' : 'border-[#30363d]'}`}
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-gray-500">{mission.length} characters</span>
          </div>
          {error && <p className="text-red-400 text-sm mt-1">{error}</p>}

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
                  onClick={() => { setMission(ex); setShowExamples(false); setError(''); }}
                  className="block w-full text-left text-sm text-gray-300 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-lg p-3 transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Keywords */}
        <div>
          <label className="block text-base font-semibold mb-1">Keywords (Optional)</label>
          <p className="text-sm text-gray-400 mb-3">Add specific focus areas to refine your matches</p>

          <div className="flex gap-2">
            <input
              value={keywordInput}
              onChange={e => setKeywordInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a keyword and press Enter"
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
            <p className="text-xs text-gray-500 mb-2">Suggested keywords:</p>
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
