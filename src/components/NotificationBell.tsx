import { useState, useRef, useEffect, useCallback } from 'react';
import { Bell, Check, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

/**
 * FM-IC-NTF-002 — in-app notification surface.
 *
 * The deadline-change alert pipeline already lands rows in
 * `notification_queue` (see check-deadlines / process-notifications) and
 * emails them out. This bell surfaces those same alerts INSIDE the app so a
 * logged-in user sees "a funder moved a deadline" without depending on email
 * — the user-facing path the usability audit flagged as missing.
 *
 * Reads are RLS-scoped to the current user (auth.uid() = user_id) and
 * mark-as-read uses the matching UPDATE policy added in
 * 20260606120000_notification_read_state.sql.
 */

interface NotifRow {
  id: string;
  type: string;
  payload: Record<string, any>;
  created_at: string;
  read_at: string | null;
}

const POLL_MS = 60_000;
const FETCH_LIMIT = 20;

/** Human-readable title for a queued notification. Defensive about payload shape. */
function notifTitle(n: NotifRow): string {
  const p = n.payload || {};
  switch (n.type) {
    case 'deadline_changed': {
      const name = p.grant_name || p.funder_name || 'A tracked grant';
      const dir =
        p.direction === 'extended' ? 'extended'
        : p.direction === 'moved_earlier' ? 'moved earlier'
        : 'changed';
      return `Deadline ${dir}: ${name}`;
    }
    case 'deadline_reminder': {
      const name = p.grant_name || p.funder_name || 'A tracked grant';
      const d = Number(p.days_until);
      const when = !Number.isFinite(d) ? 'soon' : d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
      return `Deadline ${when}: ${name}`;
    }
    case 'task_reminder':
      return `Task due: ${p.task_title || 'Untitled task'}`;
    case 'task_assignment':
      return `Task assigned: ${p.task_title || 'Untitled task'}`;
    case 'task_completed':
      return `Task completed: ${p.task_title || 'Untitled task'}`;
    case 'new_match': {
      const count = Number(p.new_count) || (Array.isArray(p.top_matches) ? p.top_matches.length : 0);
      const proj = p.project_name || 'your project';
      return `${count} new funder match${count === 1 ? '' : 'es'} for ${proj}`;
    }
    case 'weekly_digest':
      return 'Your weekly FunderMatch digest';
    default:
      return 'Notification';
  }
}

/** Optional one-line detail under the title. */
function notifDetail(n: NotifRow): string | null {
  const p = n.payload || {};
  if (n.type === 'deadline_changed' && p.old_deadline && p.new_deadline) {
    return `${p.old_deadline} → ${p.new_deadline}`;
  }
  if (n.type === 'deadline_reminder' && p.deadline) {
    return `Due ${p.deadline}`;
  }
  return null;
}

/** Convert a stored absolute link to an in-app route path (same-origin only). */
function toInternalPath(link: unknown): string | null {
  if (typeof link !== 'string' || !link) return null;
  try {
    const u = new URL(link, window.location.origin);
    if (u.origin !== window.location.origin) return null; // never navigate off-site
    return u.pathname + u.search + u.hash;
  } catch {
    return link.startsWith('/') ? link : null;
  }
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

export default function NotificationBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<NotifRow[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const unread = rows.filter((r) => !r.read_at).length;

  const fetchRows = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('notification_queue')
      .select('id, type, payload, created_at, read_at')
      .order('created_at', { ascending: false })
      .limit(FETCH_LIMIT);
    if (!error && data) setRows(data as NotifRow[]);
  }, [user]);

  // Initial load + lightweight polling so alerts appear without a refresh.
  useEffect(() => {
    if (!user) {
      setRows([]);
      return;
    }
    fetchRows();
    const id = window.setInterval(fetchRows, POLL_MS);
    return () => window.clearInterval(id);
  }, [user, fetchRows]);

  // Close on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function markRead(ids: string[]) {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    setRows((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, read_at: now } : r)));
    await supabase.from('notification_queue').update({ read_at: now }).in('id', ids);
  }

  async function markAllRead() {
    const ids = rows.filter((r) => !r.read_at).map((r) => r.id);
    await markRead(ids);
  }

  async function onOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      setLoading(true);
      await fetchRows();
      setLoading(false);
    }
  }

  function onSelect(n: NotifRow) {
    if (!n.read_at) markRead([n.id]);
    const path = toInternalPath(n.payload?.link);
    setOpen(false);
    if (path) navigate(path);
  }

  if (!user) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={onOpen}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        className="relative flex items-center justify-center w-10 h-10 min-h-[44px] min-w-[44px] text-gray-400 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-red-500 rounded-full">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-80 max-w-[calc(100vw-2rem)] bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-50"
          role="menu"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#30363d]">
            <span className="text-sm font-semibold text-white">Notifications</span>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
              >
                <Check size={12} /> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {loading && rows.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-gray-500">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : rows.length === 0 ? (
              <p className="px-4 py-8 text-sm text-gray-500 text-center">You're all caught up.</p>
            ) : (
              rows.map((n) => {
                const detail = notifDetail(n);
                return (
                  <button
                    key={n.id}
                    role="menuitem"
                    onClick={() => onSelect(n)}
                    className={`w-full text-left px-4 py-3 border-b border-[#21262d] last:border-b-0 hover:bg-white/[0.04] transition-colors ${
                      n.read_at ? 'opacity-70' : ''
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.read_at && (
                        <span className="mt-1.5 w-2 h-2 shrink-0 rounded-full bg-blue-500" aria-hidden="true" />
                      )}
                      <div className={n.read_at ? 'flex-1' : 'flex-1 -ml-0'}>
                        <p className="text-sm text-gray-200 leading-snug">{notifTitle(n)}</p>
                        {detail && <p className="text-xs text-gray-500 mt-0.5">{detail}</p>}
                        <p className="text-[11px] text-gray-600 mt-0.5">{relativeTime(n.created_at)}</p>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
