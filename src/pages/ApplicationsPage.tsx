import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getEdgeFunctionHeaders, supabase } from '../lib/supabase';
import NavBar from '../components/NavBar';
import { Plus, Trash2, FileText, BookOpen, Star } from 'lucide-react';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';
const KB_URL = `${SUPABASE_URL}/functions/v1/knowledge-base`;

interface KBEntry {
  id: string;
  title: string;
  content: string;
  source_type: string;
  file_name: string | null;
  sections: any[];
  created_at: string;
}

interface BookmarkedPassage {
  id: string;
  kb_entry_id: string;
  passage_text: string;
  rating: number;
  created_at: string;
}

export default function ApplicationsPage() {
  const { user, loading } = useAuth();
  const [entries, setEntries] = useState<KBEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<KBEntry | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkedPassage[]>([]);
  const [bookmarkText, setBookmarkText] = useState('');
  const [showBookmarkForm, setShowBookmarkForm] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      loadEntries();
    }
  }, [user, loading]);

  useEffect(() => {
    if (selectedEntry) {
      loadBookmarks(selectedEntry.id);
    }
  }, [selectedEntry]);

  const loadEntries = async () => {
    try {
      setIsLoading(true);
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(KB_URL, { headers });
      if (res.ok) setEntries(await res.json());
    } catch (err) {
      console.error('Error loading knowledge base:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    try {
      const headers = await getEdgeFunctionHeaders();
      const res = await fetch(KB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ title: newTitle.trim(), content: newContent.trim(), source_type: 'manual' }),
      });
      if (res.ok) {
        setNewTitle('');
        setNewContent('');
        setShowForm(false);
        loadEntries();
      }
    } catch (err) {
      console.error('Error adding entry:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const headers = await getEdgeFunctionHeaders();
      await fetch(`${KB_URL}?id=${id}`, { method: 'DELETE', headers });
      setEntries(prev => prev.filter(e => e.id !== id));
      if (selectedEntry?.id === id) setSelectedEntry(null);
    } catch (err) {
      console.error('Error deleting entry:', err);
    }
  };

  const loadBookmarks = async (kbId: string) => {
    try {
      const { data, error } = await supabase
        .from('bookmarked_passages')
        .select('*')
        .eq('kb_entry_id', kbId)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error loading bookmarks:', error);
        return;
      }
      setBookmarks(data || []);
    } catch (err) {
      console.error('Error loading bookmarks:', err);
    }
  };

  const handleAddBookmark = async () => {
    if (!selectedEntry || !bookmarkText.trim()) return;

    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from('bookmarked_passages')
        .insert({
          kb_entry_id: selectedEntry.id,
          user_id: currentUser?.id,
          passage_text: bookmarkText.trim(),
          rating: 3,
        })
        .select()
        .single();

      if (error) {
        console.error('Error adding bookmark:', error);
        return;
      }

      setBookmarks([data, ...bookmarks]);
      setBookmarkText('');
      setShowBookmarkForm(false);
    } catch (err) {
      console.error('Error adding bookmark:', err);
    }
  };

  const handleRatingChange = async (bookmarkId: string, newRating: number) => {
    try {
      const { error } = await supabase
        .from('bookmarked_passages')
        .update({ rating: newRating })
        .eq('id', bookmarkId);

      if (error) {
        console.error('Error updating rating:', error);
        return;
      }

      setBookmarks(prev =>
        prev.map(b => (b.id === bookmarkId ? { ...b, rating: newRating } : b))
      );
    } catch (err) {
      console.error('Error updating rating:', err);
    }
  };

  if (loading) return null;

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />
      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Application Knowledge Base</h1>
            <p className="text-gray-400 text-sm mt-1">Store past applications to power AI-assisted grant writing</p>
          </div>
          <button onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm transition-colors">
            <Plus size={16} /> Add Content
          </button>
        </div>

        {showForm && (
          <div className="mb-6 p-4 bg-[#161b22] border border-[#30363d] rounded-lg">
            <h3 className="text-sm font-semibold mb-3">Add Application Content</h3>
            <input type="text" value={newTitle} onChange={e => setNewTitle(e.target.value)}
              placeholder="Title (e.g., 'Ford Foundation 2025 LOI')"
              className="w-full mb-3 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
            <textarea value={newContent} onChange={e => setNewContent(e.target.value)}
              placeholder="Paste your application text, proposal sections, or notes here..."
              rows={8}
              className="w-full mb-3 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Cancel</button>
              <button onClick={handleAdd} disabled={!newTitle.trim() || !newContent.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm transition-colors">Save</button>
            </div>
          </div>
        )}

        <div className="grid md:grid-cols-3 gap-6">
          {/* Entry list */}
          <div className="md:col-span-1">
            <div className="space-y-2">
              {isLoading && <div className="text-gray-500 text-sm p-4">Loading...</div>}
              {!isLoading && entries.length === 0 && (
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-6 text-center">
                  <BookOpen size={24} className="mx-auto text-gray-500 mb-2" />
                  <p className="text-sm text-gray-500">No entries yet. Add past applications to build your knowledge base.</p>
                </div>
              )}
              {entries.map(entry => (
                <button key={entry.id} onClick={() => setSelectedEntry(entry)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    selectedEntry?.id === entry.id ? 'bg-blue-900/20 border-blue-500' : 'bg-[#161b22] border-[#30363d] hover:border-[#484f58]'
                  }`}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-2">
                      <FileText size={14} className="mt-0.5 text-gray-500 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium text-white">{entry.title}</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {entry.source_type} | {new Date(entry.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); handleDelete(entry.id); }}
                      className="text-gray-600 hover:text-red-400 flex-shrink-0"><Trash2 size={14} /></button>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Entry detail / preview */}
          <div className="md:col-span-2">
            {selectedEntry ? (
              <div className="space-y-4">
                <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-lg font-semibold mb-1">{selectedEntry.title}</h3>
                      <p className="text-xs text-gray-500">{selectedEntry.source_type} | Added {new Date(selectedEntry.created_at).toLocaleDateString()}</p>
                    </div>
                    <button
                      onClick={() => setShowBookmarkForm(!showBookmarkForm)}
                      className="px-3 py-2 bg-yellow-600/20 hover:bg-yellow-600/30 border border-yellow-500/30 rounded text-sm text-yellow-400 transition-colors">
                      <Star size={14} className="inline mr-1" />
                      Bookmark
                    </button>
                  </div>

                  {showBookmarkForm && (
                    <div className="mb-4 p-3 bg-[#0d1117] border border-[#30363d] rounded-lg">
                      <textarea
                        value={bookmarkText}
                        onChange={e => setBookmarkText(e.target.value)}
                        placeholder="Select or paste the passage you want to bookmark..."
                        rows={4}
                        className="w-full mb-2 bg-[#0d1117] border border-[#30363d] rounded px-2 py-2 text-sm text-gray-300 focus:outline-none focus:border-yellow-500" />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setShowBookmarkForm(false)}
                          className="px-3 py-1 text-gray-400 hover:text-white text-sm">
                          Cancel
                        </button>
                        <button
                          onClick={handleAddBookmark}
                          disabled={!bookmarkText.trim()}
                          className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 rounded text-sm text-white transition-colors">
                          Save Passage
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="prose prose-invert text-sm whitespace-pre-wrap text-gray-300 leading-relaxed max-h-[400px] overflow-y-auto border-t border-[#30363d] pt-4">
                    {selectedEntry.content}
                  </div>

                  {selectedEntry.sections && selectedEntry.sections.length > 0 && (
                    <div className="mt-4 border-t border-[#30363d] pt-4">
                      <h4 className="text-sm font-semibold mb-2">Sections</h4>
                      {selectedEntry.sections.map((s: any, i: number) => (
                        <div key={i} className="mb-2 text-xs text-gray-400">{s.title || `Section ${i + 1}`}</div>
                      ))}
                    </div>
                  )}
                </div>

                {bookmarks.length > 0 && (
                  <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-5">
                    <h4 className="text-sm font-semibold mb-3">Bookmarked Passages ({bookmarks.length})</h4>
                    <div className="space-y-3">
                      {bookmarks.map(bookmark => (
                        <div key={bookmark.id} className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3">
                          <p className="text-sm text-gray-300 mb-2 line-clamp-2">{bookmark.passage_text}</p>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-gray-500">{new Date(bookmark.created_at).toLocaleDateString()}</span>
                            <div className="flex gap-0.5">
                              {[1, 2, 3, 4, 5].map(star => (
                                <button
                                  key={star}
                                  onClick={() => handleRatingChange(bookmark.id, star)}
                                  className={`p-0.5 transition-colors ${
                                    star <= bookmark.rating ? 'text-yellow-400' : 'text-gray-600 hover:text-gray-500'
                                  }`}>
                                  <Star size={12} fill={star <= bookmark.rating ? 'currentColor' : 'none'} />
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-12 text-center text-gray-500">
                <FileText size={32} className="mx-auto mb-3" />
                <p className="text-sm">Select an entry to preview its content</p>
                <p className="text-xs mt-1">Your knowledge base powers AI-assisted grant draft generation</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
