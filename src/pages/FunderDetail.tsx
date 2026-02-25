import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, BookmarkCheck, Copy, Phone, Globe, MapPin, User, Mail } from 'lucide-react';
import { funders } from '../data/funders';
import { issaved, saveFunder, unsaveFunder } from '../utils/storage';

export default function FunderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { mission = '', keywords = [] } = location.state || {};
  const funder = funders.find(f => f.id === id);
  const [saved, setSaved] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  useEffect(() => {
    if (id) setSaved(issaved(id));
  }, [id]);

  if (!funder) return (
    <div className="min-h-screen bg-[#0d1117] text-white flex items-center justify-center">
      <div className="text-center">
        <p className="text-2xl font-bold mb-4">Funder not found</p>
        <button onClick={() => navigate('/')} className="text-blue-400 hover:underline">Go home</button>
      </div>
    </div>
  );

  const toggleSave = () => {
    if (saved) { unsaveFunder(funder.id); setSaved(false); }
    else { saveFunder(funder.id); setSaved(true); }
  };

  const copy = (text: string, type: 'email' | 'phone') => {
    navigator.clipboard.writeText(text);
    if (type === 'email') { setCopiedEmail(true); setTimeout(() => setCopiedEmail(false), 2000); }
    else { setCopiedPhone(true); setTimeout(() => setCopiedPhone(false), 2000); }
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-white py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-8 transition-colors"
        >
          <ArrowLeft size={18} />
          Back
        </button>

        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-8">
          {/* Header */}
          <div className="flex items-start justify-between mb-2">
            <h1 className="text-3xl font-bold">{funder.name}</h1>
            <button
              onClick={toggleSave}
              className={`flex items-center gap-2 border rounded-xl px-4 py-2 text-sm transition-colors ${saved ? 'border-blue-600 text-blue-400 bg-blue-900/20' : 'border-[#30363d] hover:bg-[#21262d]'}`}
            >
              {saved ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
              {saved ? 'Saved' : 'Save Funder'}
            </button>
          </div>

          <span className="inline-block bg-[#21262d] border border-[#30363d] text-gray-300 text-sm px-3 py-1 rounded-full mb-4">
            {funder.type}
          </span>

          <p className="text-gray-300 mb-6">{funder.description}</p>

          <hr className="border-[#30363d] mb-6" />

          {/* Focus Areas */}
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">Focus Areas</h2>
            <div className="flex flex-wrap gap-2">
              {funder.focusAreas.map(area => (
                <span key={area} className="bg-[#21262d] border border-[#30363d] text-gray-300 text-sm px-3 py-1 rounded-full">
                  {area}
                </span>
              ))}
            </div>
          </div>

          <hr className="border-[#30363d] mb-6" />

          {/* Recommended Next Step */}
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-3">Recommended Next Step</h2>
            <div className="bg-[#0d1117] border border-blue-800 rounded-xl px-5 py-4 text-blue-300">
              {funder.nextStep}
            </div>
          </div>

          <hr className="border-[#30363d] mb-6" />

          {/* Contact Information */}
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-4">Contact Information</h2>
            <div className="space-y-5">
              <div className="flex items-start gap-3">
                <User size={18} className="text-gray-500 mt-0.5" />
                <div>
                  <p className="font-medium">{funder.contact}</p>
                  <p className="text-sm text-gray-400">{funder.title}</p>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Mail size={18} className="text-gray-500 mt-0.5" />
                <div>
                  <p className="text-gray-300">{funder.email}</p>
                  <button
                    onClick={() => copy(funder.email, 'email')}
                    className="flex items-center gap-1 text-sm border border-[#30363d] rounded-lg px-3 py-1 mt-2 hover:bg-[#21262d] transition-colors"
                  >
                    <Copy size={13} />
                    {copiedEmail ? 'Copied!' : 'Copy Email'}
                  </button>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <Phone size={18} className="text-gray-500 mt-0.5" />
                <div>
                  <p className="text-gray-300">{funder.phone}</p>
                  <button
                    onClick={() => copy(funder.phone, 'phone')}
                    className="flex items-center gap-1 text-sm border border-[#30363d] rounded-lg px-3 py-1 mt-2 hover:bg-[#21262d] transition-colors"
                  >
                    <Copy size={13} />
                    {copiedPhone ? 'Copied!' : 'Copy Phone'}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <MapPin size={18} className="text-gray-500" />
                <p className="text-gray-300">{funder.location}</p>
              </div>

              <div className="flex items-center gap-3">
                <Globe size={18} className="text-gray-500" />
                <a
                  href={`https://${funder.website}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:underline"
                >
                  {funder.website} ↗
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom nav */}
        <div className="flex gap-3 mt-6">
          <button
            onClick={() => navigate('/results', { state: { mission, keywords } })}
            className="flex-1 border border-[#30363d] rounded-xl py-3 text-sm hover:bg-[#161b22] transition-colors"
          >
            ← Back to Results
          </button>
          <button
            onClick={() => navigate('/saved')}
            className="flex-1 border border-[#30363d] rounded-xl py-3 text-sm hover:bg-[#161b22] transition-colors"
          >
            View Saved Funders
          </button>
        </div>
      </div>
    </div>
  );
}
