import { useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';
import { requestOrganization } from '../utils/matching';

interface OrgRequestFormProps {
  initialName: string;
  onSubmitted?: () => void;
}

const inputClass =
  'w-full bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-600';

// Trello #153: lets a visitor ask for a missing nonprofit or foundation to be
// added. The request is queued and resolved against IRS records on a schedule
// (see supabase/functions/process-organization-requests).
export default function OrgRequestForm({ initialName, onSubmitted }: OrgRequestFormProps) {
  const [name, setName] = useState(initialName);
  const [ein, setEin] = useState('');
  const [state, setState] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [willEmail, setWillEmail] = useState(false);
  const [error, setError] = useState('');

  if (status === 'done') {
    return (
      <div role="status" className="flex items-start gap-2 text-sm text-gray-300">
        <CheckCircle size={16} className="text-green-400 shrink-0 mt-0.5" />
        <p>
          Thanks — we&rsquo;ll look up &ldquo;{name.trim()}&rdquo; in IRS records and add it if we find it.
          {willEmail ? ' We’ll email you what we find.' : ' Check back in a little while.'}
        </p>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('submitting');
    setError('');
    try {
      const { notify } = await requestOrganization({
        name: name.trim(),
        ein: ein.trim() || undefined,
        state: state.trim() || undefined,
        email: email.trim() || undefined,
      });
      setWillEmail(notify);
      setStatus('done');
      onSubmitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setStatus('error');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2" aria-label="Request an organization">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        minLength={2}
        maxLength={200}
        // Opened by "Request it", whose button disappears as the form appears.
        autoFocus
        aria-label="Organization name"
        placeholder="Organization name"
        className={inputClass}
      />
      <div className="grid grid-cols-2 gap-2">
        <input
          value={ein}
          onChange={(e) => setEin(e.target.value)}
          inputMode="numeric"
          // 9 digits (dash optional), or 8 without the leading zero, as the server accepts.
          pattern="\d{2}-?\d{7}|\d{8}"
          title="9-digit EIN, e.g. 12-3456789"
          aria-label="EIN (optional)"
          placeholder="EIN (optional)"
          className={inputClass}
        />
        <input
          value={state}
          onChange={(e) => setState(e.target.value.toUpperCase())}
          maxLength={2}
          pattern="[A-Za-z]{2}"
          title="2-letter state code, e.g. WA"
          aria-label="State (optional)"
          placeholder="State (optional)"
          className={inputClass}
        />
      </div>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        maxLength={254}
        aria-label="Email to notify (optional)"
        placeholder="Email me when it's added (optional)"
        className={inputClass}
      />
      {status === 'error' && <p role="alert" className="text-xs text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={status === 'submitting'}
        className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium py-2 rounded-lg transition-colors"
      >
        {status === 'submitting' && <Loader2 size={14} className="animate-spin" />}
        Request this organization
      </button>
    </form>
  );
}
