import { useState, useEffect } from 'react';
import { Save, AlertCircle, CheckCircle, Loader, Building2, Bell, Calendar, Copy, Trash2, Plus, ExternalLink } from 'lucide-react';
import { supabase, getEdgeFunctionHeaders } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import NavBar from '../components/NavBar';
import type { NotificationPreferences, CalendarFeed } from '../types';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const CALENDAR_FEED_URL = `${SUPABASE_URL}/functions/v1/calendar-feed`;

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'
];

const NTEE_CATEGORIES = [
  { code: 'A', label: 'Arts, Culture & Humanities' },
  { code: 'B', label: 'Education & Research' },
  { code: 'C', label: 'Environment & Animals' },
  { code: 'D', label: 'Health Care' },
  { code: 'E', label: 'Mental Health & Crisis Intervention' },
  { code: 'F', label: 'Voluntary Health Associations' },
  { code: 'G', label: 'Human Services' },
  { code: 'H', label: 'International, Foreign Affairs & Development' },
  { code: 'I', label: 'Public, Societal Benefit' },
  { code: 'J', label: 'Religion Related, Spiritual Development' },
  { code: 'K', label: 'Mutual & Membership Benefit' },
  { code: 'L', label: 'Unknown' },
];

const BUDGET_RANGES = [
  { value: '0-250k', label: 'Under $250,000' },
  { value: '250k-1m', label: '$250,000 - $1,000,000' },
  { value: '1m-5m', label: '$1,000,000 - $5,000,000' },
  { value: '5m-10m', label: '$5,000,000 - $10,000,000' },
  { value: '10m-50m', label: '$10,000,000 - $50,000,000' },
  { value: '50m+', label: '$50,000,000+' },
];

const REMINDER_OPTIONS = [
  { value: 30, label: '30 days before' },
  { value: 14, label: '14 days before' },
  { value: 7, label: '7 days before' },
  { value: 3, label: '3 days before' },
  { value: 1, label: '1 day before' },
  { value: 0, label: 'Day of' },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface UserProfile {
  id: string;
  display_name: string | null;
  organization_name: string | null;
  ein: string | null;
  mission_statement: string | null;
  city: string | null;
  state: string | null;
  county: string | null;
  ntee_codes: string[] | null;
  budget_range: string | null;
  updated_at: string | null;
}

type SettingsTab = 'profile' | 'notifications' | 'calendar';

function UserSettingsContent() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');
  const [_profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Profile form state
  const [displayName, setDisplayName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [ein, setEin] = useState('');
  const [missionStatement, setMissionStatement] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [county, setCounty] = useState('');
  const [nteeCodes, setNteeCodes] = useState<string[]>([]);
  const [budgetRange, setBudgetRange] = useState('');

  // Notification preferences state
  const [_notifPrefs, setNotifPrefs] = useState<NotificationPreferences | null>(null);
  const [notifLoading, setNotifLoading] = useState(false);
  const [deadlineReminders, setDeadlineReminders] = useState<number[]>([30, 14, 7, 3, 1]);
  const [taskReminders, setTaskReminders] = useState<number[]>([1]);
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [digestDay, setDigestDay] = useState(1);
  const [realtimeMatches, setRealtimeMatches] = useState(true);
  const [emailEnabled, setEmailEnabled] = useState(true);

  // Calendar feeds state
  const [calendarFeeds, setCalendarFeeds] = useState<CalendarFeed[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [newFeedProjectId, setNewFeedProjectId] = useState<string>('');
  const [newFeedIncludeTasks, setNewFeedIncludeTasks] = useState(true);
  const [copiedFeedId, setCopiedFeedId] = useState<string | null>(null);

  // Load profile
  useEffect(() => {
    const loadProfile = async () => {
      if (!user) return;

      try {
        const { data, error: fetchError } = await supabase
          .from('user_profiles')
          .select('*')
          .eq('id', user.id)
          .single();

        if (fetchError && fetchError.code !== 'PGRST116') {
          throw fetchError;
        }

        if (data) {
          setProfile(data);
          setDisplayName(data.display_name || '');
          setOrganizationName(data.organization_name || '');
          setEin(data.ein || '');
          setMissionStatement(data.mission_statement || '');
          setCity(data.city || '');
          setState(data.state || '');
          setCounty(data.county || '');
          setNteeCodes(data.ntee_codes || []);
          setBudgetRange(data.budget_range || '');
        } else {
          setProfile({
            id: user.id,
            display_name: null,
            organization_name: null,
            ein: null,
            mission_statement: null,
            city: null,
            state: null,
            county: null,
            ntee_codes: null,
            budget_range: null,
            updated_at: null,
          });
        }
      } catch (err) {
        setError('Failed to load profile');
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    loadProfile();
  }, [user]);

  // Load notification preferences
  useEffect(() => {
    if (activeTab !== 'notifications' || !user) return;
    const loadNotifPrefs = async () => {
      setNotifLoading(true);
      try {
        const { data, error: fetchError } = await supabase
          .from('notification_preferences')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (fetchError && fetchError.code !== 'PGRST116') {
          throw fetchError;
        }

        if (data) {
          setNotifPrefs(data);
          setDeadlineReminders(data.deadline_reminders || [30, 14, 7, 3, 1]);
          setTaskReminders(data.task_reminders || [1]);
          setWeeklyDigest(data.weekly_digest ?? true);
          setDigestDay(data.digest_day ?? 1);
          setRealtimeMatches(data.realtime_matches ?? true);
          setEmailEnabled(data.email_enabled ?? true);
        }
      } catch (err) {
        console.error('Error loading notification preferences:', err);
      } finally {
        setNotifLoading(false);
      }
    };
    loadNotifPrefs();
  }, [activeTab, user]);

  // Load calendar feeds and projects
  useEffect(() => {
    if (activeTab !== 'calendar' || !user) return;
    const loadCalendarData = async () => {
      setCalendarLoading(true);
      try {
        // Load feeds
        const { data: feeds } = await supabase
          .from('calendar_feeds')
          .select('*, projects(name)')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (feeds) {
          setCalendarFeeds(feeds.map((f: any) => ({
            ...f,
            feed_url: `${CALENDAR_FEED_URL}?token=${f.token}`,
          })));
        }

        // Load projects for the dropdown
        const { data: projectData } = await supabase
          .from('projects')
          .select('id, name')
          .eq('user_id', user.id)
          .order('name');

        if (projectData) setProjects(projectData);
      } catch (err) {
        console.error('Error loading calendar data:', err);
      } finally {
        setCalendarLoading(false);
      }
    };
    loadCalendarData();
  }, [activeTab, user]);

  const handleSaveProfile = async () => {
    setError('');
    setSuccess(false);
    setSaving(true);

    try {
      if (!user) {
        setError('User not authenticated');
        setSaving(false);
        return;
      }

      const { error: updateError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: user.id,
            display_name: displayName || null,
            organization_name: organizationName || null,
            ein: ein || null,
            mission_statement: missionStatement || null,
            city: city || null,
            state: state || null,
            county: county || null,
            ntee_codes: nteeCodes.length > 0 ? nteeCodes : null,
            budget_range: budgetRange || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        );

      if (updateError) {
        setError('Failed to save profile: ' + updateError.message);
        setSaving(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError('An unexpected error occurred');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveNotifications = async () => {
    setError('');
    setSuccess(false);
    setSaving(true);

    try {
      if (!user) { setSaving(false); return; }

      const { error: updateError } = await supabase
        .from('notification_preferences')
        .upsert(
          {
            user_id: user.id,
            deadline_reminders: deadlineReminders,
            task_reminders: taskReminders,
            weekly_digest: weeklyDigest,
            digest_day: digestDay,
            realtime_matches: realtimeMatches,
            email_enabled: emailEnabled,
          },
          { onConflict: 'user_id' }
        );

      if (updateError) {
        setError('Failed to save notification preferences: ' + updateError.message);
        setSaving(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError('An unexpected error occurred');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleDeadlineReminder = (day: number) => {
    setDeadlineReminders(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort((a, b) => b - a)
    );
  };

  const toggleTaskReminder = (day: number) => {
    setTaskReminders(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort((a, b) => b - a)
    );
  };

  const handleCreateFeed = async () => {
    if (!user) return;
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(CALENDAR_FEED_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          project_id: newFeedProjectId || null,
          include_tasks: newFeedIncludeTasks,
        }),
      });
      if (res.ok) {
        const feed = await res.json();
        setCalendarFeeds(prev => [{
          ...feed,
          feed_url: `${CALENDAR_FEED_URL}?token=${feed.token}`,
          projects: newFeedProjectId ? projects.find(p => p.id === newFeedProjectId) : null,
        }, ...prev]);
        setNewFeedProjectId('');
        setNewFeedIncludeTasks(true);
      }
    } catch (err) {
      console.error('Error creating feed:', err);
    }
  };

  const handleDeleteFeed = async (feedId: string) => {
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(CALENDAR_FEED_URL, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ id: feedId }),
      });
      if (res.ok) {
        setCalendarFeeds(prev => prev.filter(f => f.id !== feedId));
      }
    } catch (err) {
      console.error('Error deleting feed:', err);
    }
  };

  const copyFeedUrl = (feed: CalendarFeed) => {
    if (feed.feed_url) {
      navigator.clipboard.writeText(feed.feed_url);
      setCopiedFeedId(feed.id);
      setTimeout(() => setCopiedFeedId(null), 2000);
    }
  };

  const toggleNteeCode = (code: string) => {
    setNteeCodes((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  };

  if (loading) {
    return (
      <>
        <NavBar />
        <div className="flex items-center justify-center h-screen bg-[#0d1117]">
          <div className="text-center">
            <Loader className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-4" />
            <p className="text-gray-400">Loading profile...</p>
          </div>
        </div>
      </>
    );
  }

  const inputClass = "w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500";
  const labelClass = "block text-sm font-medium text-white mb-2";

  return (
    <>
      <NavBar />
      <div className="min-h-screen bg-[#0d1117] pt-20 pb-12">
        <div className="max-w-2xl mx-auto px-4">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">Settings</h1>
            <p className="text-gray-400">Manage your profile, notifications, and integrations</p>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-6 bg-[#161b22] border border-[#30363d] rounded-lg p-1">
            {([
              { key: 'profile' as SettingsTab, label: 'Profile', icon: Building2 },
              { key: 'notifications' as SettingsTab, label: 'Notifications', icon: Bell },
              { key: 'calendar' as SettingsTab, label: 'Calendar', icon: Calendar },
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => { setActiveTab(tab.key); setError(''); setSuccess(false); }}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-md transition-colors ${
                  activeTab === tab.key
                    ? 'bg-[#0d1117] text-white'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                <tab.icon size={16} />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Error/Success Messages */}
          {error && (
            <div className="mb-6 p-4 bg-red-900/20 border border-red-700 rounded-lg flex gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-red-400">{error}</p>
            </div>
          )}
          {success && (
            <div className="mb-6 p-4 bg-green-900/20 border border-green-700 rounded-lg flex gap-3">
              <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
              <p className="text-green-400">Settings saved successfully</p>
            </div>
          )}

          {/* ─── Profile Tab ─── */}
          {activeTab === 'profile' && (
            <>
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 space-y-6">
                {/* Email */}
                <div className="pb-6 border-b border-[#30363d]">
                  <h2 className="text-lg font-semibold text-white mb-4">Account</h2>
                  <div>
                    <label className={labelClass}>Email address</label>
                    <input
                      type="email"
                      value={user?.email || ''}
                      disabled
                      className="w-full px-4 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-gray-400 cursor-not-allowed"
                    />
                    <p className="text-xs text-gray-500 mt-1">Contact support to change email</p>
                  </div>
                </div>

                {/* Organization */}
                <div className="pb-6 border-b border-[#30363d]">
                  <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                    <Building2 className="w-5 h-5" />
                    Organization Profile
                  </h2>

                  <div className="space-y-4">
                    <div>
                      <label htmlFor="displayName" className={labelClass}>Display name</label>
                      <input id="displayName" type="text" value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="How you appear in the app" className={inputClass} />
                    </div>

                    <div>
                      <label htmlFor="orgName" className={labelClass}>Organization name</label>
                      <input id="orgName" type="text" value={organizationName}
                        onChange={(e) => setOrganizationName(e.target.value)}
                        placeholder="Your nonprofit name" className={inputClass} />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label htmlFor="ein" className={labelClass}>EIN</label>
                        <input id="ein" type="text" value={ein}
                          onChange={(e) => setEin(e.target.value)}
                          placeholder="12-3456789" className={inputClass} />
                      </div>
                      <div>
                        <label htmlFor="budget" className={labelClass}>Annual budget range</label>
                        <select id="budget" value={budgetRange}
                          onChange={(e) => setBudgetRange(e.target.value)} className={inputClass}>
                          <option value="">Select budget range</option>
                          {BUDGET_RANGES.map((range) => (
                            <option key={range.value} value={range.value}>{range.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div>
                      <label htmlFor="mission" className={labelClass}>Mission statement</label>
                      <textarea id="mission" value={missionStatement}
                        onChange={(e) => setMissionStatement(e.target.value)}
                        placeholder="Describe your organization's mission..."
                        rows={3} className={inputClass + ' resize-none'} />
                    </div>
                  </div>
                </div>

                {/* Location */}
                <div className="pb-6 border-b border-[#30363d]">
                  <h2 className="text-lg font-semibold text-white mb-4">Location</h2>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label htmlFor="city" className={labelClass}>City</label>
                      <input id="city" type="text" value={city}
                        onChange={(e) => setCity(e.target.value)} placeholder="City" className={inputClass} />
                    </div>
                    <div>
                      <label htmlFor="state" className={labelClass}>State</label>
                      <select id="state" value={state}
                        onChange={(e) => setState(e.target.value)} className={inputClass}>
                        <option value="">Select</option>
                        {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="county" className={labelClass}>County</label>
                      <input id="county" type="text" value={county}
                        onChange={(e) => setCounty(e.target.value)} placeholder="County" className={inputClass} />
                    </div>
                  </div>
                </div>

                {/* Focus Areas */}
                <div>
                  <h2 className="text-lg font-semibold text-white mb-4">Primary focus areas</h2>
                  <div className="grid grid-cols-2 gap-2">
                    {NTEE_CATEGORIES.map((category) => (
                      <label key={category.code} className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={nteeCodes.includes(category.code)}
                          onChange={() => toggleNteeCode(category.code)}
                          className="w-4 h-4 rounded bg-[#0d1117] border border-[#30363d] text-blue-600 cursor-pointer" />
                        <span className="text-sm text-gray-300">{category.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-6">
                <button onClick={handleSaveProfile} disabled={saving}
                  className="flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white rounded-lg font-medium transition-colors">
                  {saving ? (<><Loader className="w-5 h-5 animate-spin" /> Saving...</>) : (<><Save className="w-5 h-5" /> Save changes</>)}
                </button>
              </div>
            </>
          )}

          {/* ─── Notifications Tab ─── */}
          {activeTab === 'notifications' && (
            <>
              {notifLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader className="w-6 h-6 text-gray-400 animate-spin" />
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Master Toggle */}
                  <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-lg font-semibold text-white">Email notifications</h2>
                        <p className="text-sm text-gray-400 mt-1">Receive email reminders for deadlines and tasks</p>
                      </div>
                      <button
                        onClick={() => setEmailEnabled(!emailEnabled)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${emailEnabled ? 'bg-blue-600' : 'bg-gray-600'}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${emailEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                    </div>
                  </div>

                  {/* Deadline Reminders */}
                  <div className={`bg-[#161b22] border border-[#30363d] rounded-lg p-6 ${!emailEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                    <h2 className="text-lg font-semibold text-white mb-1">Deadline reminders</h2>
                    <p className="text-sm text-gray-400 mb-4">Get notified before grant deadlines</p>
                    <div className="space-y-2">
                      {REMINDER_OPTIONS.map(opt => (
                        <label key={`dl-${opt.value}`} className="flex items-center gap-3 cursor-pointer py-1">
                          <input type="checkbox" checked={deadlineReminders.includes(opt.value)}
                            onChange={() => toggleDeadlineReminder(opt.value)}
                            className="w-4 h-4 rounded bg-[#0d1117] border border-[#30363d] text-blue-600 cursor-pointer" />
                          <span className="text-sm text-gray-300">{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Task Reminders */}
                  <div className={`bg-[#161b22] border border-[#30363d] rounded-lg p-6 ${!emailEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                    <h2 className="text-lg font-semibold text-white mb-1">Task reminders</h2>
                    <p className="text-sm text-gray-400 mb-4">Get notified before tasks are due</p>
                    <div className="space-y-2">
                      {REMINDER_OPTIONS.filter(o => o.value <= 7).map(opt => (
                        <label key={`task-${opt.value}`} className="flex items-center gap-3 cursor-pointer py-1">
                          <input type="checkbox" checked={taskReminders.includes(opt.value)}
                            onChange={() => toggleTaskReminder(opt.value)}
                            className="w-4 h-4 rounded bg-[#0d1117] border border-[#30363d] text-blue-600 cursor-pointer" />
                          <span className="text-sm text-gray-300">{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Weekly Digest */}
                  <div className={`bg-[#161b22] border border-[#30363d] rounded-lg p-6 ${!emailEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h2 className="text-lg font-semibold text-white">Weekly digest</h2>
                        <p className="text-sm text-gray-400 mt-1">Summary of upcoming deadlines, tasks, and new matches</p>
                      </div>
                      <button
                        onClick={() => setWeeklyDigest(!weeklyDigest)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${weeklyDigest ? 'bg-blue-600' : 'bg-gray-600'}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${weeklyDigest ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                    </div>
                    {weeklyDigest && (
                      <div>
                        <label className="text-sm text-gray-400 mb-2 block">Send on</label>
                        <select value={digestDay} onChange={(e) => setDigestDay(Number(e.target.value))} className={inputClass + ' max-w-[200px]'}>
                          {DAY_NAMES.map((name, idx) => (
                            <option key={idx} value={idx}>{name}</option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  {/* New Match Alerts */}
                  <div className={`bg-[#161b22] border border-[#30363d] rounded-lg p-6 ${!emailEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-lg font-semibold text-white">New match alerts</h2>
                        <p className="text-sm text-gray-400 mt-1">Get notified when new high-scoring funders are found</p>
                      </div>
                      <button
                        onClick={() => setRealtimeMatches(!realtimeMatches)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${realtimeMatches ? 'bg-blue-600' : 'bg-gray-600'}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${realtimeMatches ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                    </div>
                  </div>

                  {/* Team Notifications */}
                  <div className={`bg-[#161b22] border border-[#30363d] rounded-lg p-6 ${!emailEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                    <h2 className="text-lg font-semibold text-white mb-1">Team notifications</h2>
                    <p className="text-sm text-gray-400 mb-4">Stay informed about team activity and collaboration events</p>
                    <div className="space-y-3">
                      {[
                        { id: 'task_assigned', label: 'Task assigned to me', desc: 'When someone assigns a task to you' },
                        { id: 'status_changed', label: 'Grant status changed', desc: 'When a tracked grant changes pipeline status' },
                        { id: 'compliance_deadline', label: 'Compliance deadline approaching', desc: 'Reminders for upcoming compliance requirements' },
                        { id: 'team_member_joined', label: 'Team member joined', desc: 'When a new member accepts an invitation' },
                        { id: 'deadline_changed', label: 'Funder deadline changed', desc: 'When a tracked funder changes a grant deadline' },
                      ].map(item => (
                        <label key={item.id} className="flex items-start gap-3 cursor-pointer py-1">
                          <input type="checkbox" defaultChecked
                            className="w-4 h-4 rounded bg-[#0d1117] border border-[#30363d] text-blue-600 cursor-pointer mt-0.5" />
                          <div>
                            <span className="text-sm text-gray-300">{item.label}</span>
                            <p className="text-xs text-gray-500">{item.desc}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <button onClick={handleSaveNotifications} disabled={saving}
                      className="flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 text-white rounded-lg font-medium transition-colors">
                      {saving ? (<><Loader className="w-5 h-5 animate-spin" /> Saving...</>) : (<><Save className="w-5 h-5" /> Save preferences</>)}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ─── Calendar Tab ─── */}
          {activeTab === 'calendar' && (
            <>
              {calendarLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader className="w-6 h-6 text-gray-400 animate-spin" />
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Explanation */}
                  <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                    <h2 className="text-lg font-semibold text-white mb-2">Calendar feeds</h2>
                    <p className="text-sm text-gray-400">
                      Subscribe to .ics calendar feeds in Google Calendar, Outlook, or Apple Calendar
                      to see grant deadlines and task due dates alongside your other events.
                    </p>
                  </div>

                  {/* Create New Feed */}
                  <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                    <h3 className="text-md font-semibold text-white mb-4">Create new feed</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="text-sm text-gray-400 mb-2 block">Project (optional - leave blank for all projects)</label>
                        <select value={newFeedProjectId} onChange={(e) => setNewFeedProjectId(e.target.value)} className={inputClass}>
                          <option value="">All projects</option>
                          {projects.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>

                      <label className="flex items-center gap-3 cursor-pointer">
                        <input type="checkbox" checked={newFeedIncludeTasks}
                          onChange={(e) => setNewFeedIncludeTasks(e.target.checked)}
                          className="w-4 h-4 rounded bg-[#0d1117] border border-[#30363d] text-blue-600 cursor-pointer" />
                        <span className="text-sm text-gray-300">Include task due dates</span>
                      </label>

                      <button onClick={handleCreateFeed}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors">
                        <Plus size={16} />
                        Create feed
                      </button>
                    </div>
                  </div>

                  {/* Existing Feeds */}
                  {calendarFeeds.length > 0 && (
                    <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                      <h3 className="text-md font-semibold text-white mb-4">Active feeds</h3>
                      <div className="space-y-3">
                        {calendarFeeds.map(feed => (
                          <div key={feed.id} className="flex items-center gap-3 p-3 bg-[#0d1117] border border-[#30363d] rounded-lg">
                            <Calendar size={16} className="text-blue-400 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-white truncate">
                                {(feed as any).projects?.name || 'All Projects'}
                                {feed.include_tasks ? ' + Tasks' : ''}
                              </p>
                              <p className="text-xs text-gray-500 truncate mt-0.5">{feed.feed_url}</p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <button onClick={() => copyFeedUrl(feed)}
                                className="p-1.5 text-gray-400 hover:text-white transition-colors" title="Copy URL">
                                {copiedFeedId === feed.id ? <CheckCircle size={16} className="text-green-400" /> : <Copy size={16} />}
                              </button>
                              <a href={feed.feed_url} target="_blank" rel="noopener noreferrer"
                                className="p-1.5 text-gray-400 hover:text-white transition-colors" title="Open feed">
                                <ExternalLink size={16} />
                              </a>
                              <button onClick={() => handleDeleteFeed(feed.id)}
                                className="p-1.5 text-gray-400 hover:text-red-400 transition-colors" title="Delete feed">
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {calendarFeeds.length === 0 && (
                    <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-8 text-center">
                      <Calendar size={32} className="mx-auto text-gray-500 mb-3" />
                      <p className="text-gray-400 mb-1">No calendar feeds yet</p>
                      <p className="text-gray-500 text-sm">Create a feed above to get started</p>
                    </div>
                  )}

                  {/* How to subscribe */}
                  <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6">
                    <h3 className="text-md font-semibold text-white mb-3">How to subscribe</h3>
                    <div className="space-y-3 text-sm text-gray-400">
                      <div>
                        <p className="text-white font-medium mb-1">Google Calendar</p>
                        <p>Settings &rarr; Add calendar &rarr; From URL &rarr; paste the feed URL</p>
                      </div>
                      <div>
                        <p className="text-white font-medium mb-1">Outlook</p>
                        <p>Add calendar &rarr; Subscribe from web &rarr; paste the feed URL</p>
                      </div>
                      <div>
                        <p className="text-white font-medium mb-1">Apple Calendar</p>
                        <p>File &rarr; New Calendar Subscription &rarr; paste the feed URL</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default function UserSettingsPage() {
  return <UserSettingsContent />;
}
