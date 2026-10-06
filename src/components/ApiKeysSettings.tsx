// FM-IC-CFG-002: in-app manager for personal API keys used by the FunderMatch
// public API (workflow automation). Create, view, and revoke keys; the raw
// secret is shown exactly once at creation.
import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Copy, Check, KeyRound, ExternalLink } from 'lucide-react';
import { getEdgeFunctionHeaders } from '../lib/supabase';

const API_KEYS_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/api-keys';
const OPENAPI_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/public-api/openapi.json';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export default function ApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(API_KEYS_URL, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setKeys(await res.json());
    } catch (e: any) {
      console.error('Failed to load API keys:', e);
      setError('Could not load API keys.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const createKey = async () => {
    setCreating(true);
    setError('');
    setFreshSecret(null);
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(API_KEYS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: newName.trim() || 'API key' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setFreshSecret(data.secret);
      setNewName('');
      await load();
    } catch (e: any) {
      console.error('Failed to create API key:', e);
      setError('Could not create the API key.');
    } finally {
      setCreating(false);
    }
  };

  const revokeKey = async (id: string) => {
    setError('');
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(`${API_KEYS_URL}?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      console.error('Failed to revoke API key:', e);
      setError('Could not revoke the key.');
    }
  };

  const copySecret = async () => {
    if (!freshSecret) return;
    try {
      await navigator.clipboard.writeText(freshSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may be unavailable */ }
  };

  const active = keys.filter(k => !k.revoked_at);

  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6">
      <h2 className="text-lg font-semibold text-white mb-1 flex items-center gap-2">
        <KeyRound size={18} /> API keys
      </h2>
      <p className="text-sm text-gray-400 mb-4">
        Issue keys for the FunderMatch public API to automate workflows — pull
        your pipeline into Zapier, Make, a spreadsheet, or your own scripts.{' '}
        <a
          href={OPENAPI_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
        >
          OpenAPI spec <ExternalLink size={12} />
        </a>
      </p>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {/* Freshly-created secret (shown once) */}
      {freshSecret && (
        <div className="mb-5 rounded-xl border border-amber-700 bg-amber-900/20 p-4">
          <p className="text-sm text-amber-200 mb-2 font-medium">
            Copy your key now — it won&apos;t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-white bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 break-all">
              {freshSecret}
            </code>
            <button
              onClick={copySecret}
              aria-label="Copy API key"
              className="inline-flex items-center gap-1 text-sm text-gray-200 hover:text-white border border-gray-600 rounded-lg px-3 py-2"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      {/* Existing keys */}
      {loading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <Loader2 className="animate-spin" size={16} /> Loading…
        </div>
      ) : active.length === 0 ? (
        <p className="text-sm text-gray-500 italic mb-4">No active API keys.</p>
      ) : (
        <ul className="space-y-2 mb-5">
          {active.map(k => (
            <li
              key={k.id}
              className="flex items-center justify-between bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5"
            >
              <div>
                <span className="text-sm text-white font-medium">{k.name}</span>
                <span className="ml-2 text-xs text-gray-500 font-mono">{k.key_prefix}…</span>
                <span className="ml-2 text-xs text-gray-600">
                  {k.last_used_at
                    ? `last used ${new Date(k.last_used_at).toLocaleDateString()}`
                    : 'never used'}
                </span>
              </div>
              <button
                onClick={() => revokeKey(k.id)}
                aria-label={`Revoke API key ${k.name}`}
                className="text-gray-500 hover:text-red-400 transition-colors"
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Create new key */}
      <div className="border-t border-[#30363d] pt-4">
        <h3 className="text-sm font-semibold text-white mb-3">Create a key</h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="Key name (e.g. Zapier integration)"
            aria-label="API key name"
            className="flex-1 rounded-md bg-gray-800 border border-gray-600 px-2 py-1.5 text-sm text-white"
          />
          <button
            onClick={createKey}
            disabled={creating}
            className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-xl px-4 py-2 text-sm transition-colors"
          >
            {creating ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
            Create key
          </button>
        </div>
      </div>
    </div>
  );
}
