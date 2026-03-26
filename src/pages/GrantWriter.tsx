import { useLocation, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft, Check, CheckCircle2, ChevronDown, ChevronUp, Copy, Download,
  FileText, Loader2, RefreshCw, Trash2, Upload, Wand2, X,
} from 'lucide-react';
import { asBlob } from 'html-docx-js-typescript';
import { saveAs } from 'file-saver';
import { Funder, GenerationPhase, OrgDetails, UploadedGrantFile } from '../types';
import { getEdgeFunctionHeaders, supabase } from '../lib/supabase';
import { formatGrantRange, formatTotalGiving } from '../utils/matching';
import NavBar from '../components/NavBar';

const GRANT_WRITER_URL =
  'https://tgtotjvdubhjxzybmdex.supabase.co/functions/v1/grant-writer';

const ACCEPTED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];
const MAX_FILES = 3;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const FILE_TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'text/plain': 'TXT',
};

// ── Markdown renderer ────────────────────────────────────────────────────────

function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const parts: string[] = [];

  for (const rawLine of lines) {
    const esc = rawLine
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const inl = esc.replace(
      /\*\*(.+?)\*\*/g,
      '<strong class="font-semibold text-white">$1</strong>',
    );

    if (rawLine.startsWith('### ')) {
      parts.push(
        `<h3 class="text-base font-bold text-white mt-7 mb-2 pb-1 border-b border-[#30363d]">${inl.slice(4)}</h3>`,
      );
    } else if (rawLine.startsWith('## ')) {
      parts.push(
        `<h2 class="text-xl font-bold text-blue-400 mt-10 mb-3 first:mt-0">${inl.slice(3)}</h2>`,
      );
    } else if (rawLine === '---') {
      parts.push('<hr class="border-[#30363d] my-6">');
    } else if (rawLine.startsWith('- [x] ')) {
      parts.push(
        `<div class="flex items-start gap-2 my-1.5 text-sm"><span class="text-green-400 font-bold shrink-0 mt-0.5">✓</span><span class="text-gray-300">${inl.slice(6)}</span></div>`,
      );
    } else if (rawLine.startsWith('- [ ] ')) {
      parts.push(
        `<div class="flex items-start gap-2 my-1.5 text-sm"><span class="text-gray-400 shrink-0 mt-0.5">○</span><span class="text-gray-300">${inl.slice(6)}</span></div>`,
      );
    } else if (rawLine.startsWith('  - ')) {
      parts.push(
        `<div class="flex items-start gap-2 ml-5 my-1 text-sm"><span class="text-gray-400 shrink-0 mt-0.5">–</span><span class="text-gray-400">${inl.slice(4)}</span></div>`,
      );
    } else if (rawLine.startsWith('- ')) {
      parts.push(
        `<div class="flex items-start gap-2 my-1.5 text-sm"><span class="text-gray-400 shrink-0 mt-0.5">•</span><span class="text-gray-300">${inl.slice(2)}</span></div>`,
      );
    } else if (rawLine === '') {
      parts.push('<div class="h-1.5"></div>');
    } else {
      parts.push(`<p class="text-gray-300 leading-relaxed text-sm">${inl}</p>`);
    }
  }

  return parts.join('');
}

// ── Component ────────────────────────────────────────────────────────────────

export default function GrantWriter() {
  const location = useLocation();
  const navigate = useNavigate();

  const funder: Funder | null = (location.state as any)?.funder ?? null;

  // Page title
  useEffect(() => {
    const name = funder?.name
      ? `AI Grant Writer — ${funder.name} | FunderMatch`
      : 'AI Grant Writer | FunderMatch';
    document.title = name;
    const desc = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    if (desc)
      desc.content =
        'Generate a complete, funder-specific grant application draft in seconds using AI. Includes research-backed data, style matching, and compliance checklist.';
  }, [funder]);

  // Redirect if no funder
  useEffect(() => {
    if (!funder) navigate('/saved', { replace: true });
  }, [funder, navigate]);

  // ── Form state ──────────────────────────────────────────────────────────

  const [mission, setMission] = useState(
    () => sessionStorage.getItem('ff_mission') || '',
  );
  const [orgDetails, setOrgDetails] = useState<OrgDetails>({
    orgName: '',
    orgDesc: '',
    budget: '',
    targetPop: '',
    geoFocus: sessionStorage.getItem('ff_location') || '',
    programName: '',
    programDesc: '',
    programBudget: '',
    outcomes: '',
    timeline: '',
  });

  const [showOrg, setShowOrg] = useState(false);
  const [showProgram, setShowProgram] = useState(false);
  const [showPastGrants, setShowPastGrants] = useState(true);

  // ── Upload state ────────────────────────────────────────────────────────

  const [uploadedFiles, setUploadedFiles] = useState<UploadedGrantFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionId = useRef(
    sessionStorage.getItem('ff_grant_session') ||
      (() => {
        const id = crypto.randomUUID();
        sessionStorage.setItem('ff_grant_session', id);
        return id;
      })(),
  );

  // ── Generation state ────────────────────────────────────────────────────

  const [output, setOutput] = useState('');
  const [phase, setPhase] = useState<GenerationPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [researchStats, setResearchStats] = useState<{
    statsFound: number;
    sourcesFound: number;
    fallback: boolean;
  } | null>(null);

  const outputEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll during streaming
  useEffect(() => {
    if (phase === 'generating') {
      outputEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [output, phase]);

  const updateOrg = (key: keyof OrgDetails, value: string) => {
    setOrgDetails((prev) => ({ ...prev, [key]: value }));
  };

  // ── File upload handlers ────────────────────────────────────────────────

  const uploadFile = useCallback(
    async (file: File) => {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setUploadError(`Unsupported file type. Please use PDF, DOCX, or TXT.`);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        setUploadError(`File too large (max 10 MB).`);
        return;
      }
      if (uploadedFiles.length >= MAX_FILES) {
        setUploadError(`Maximum ${MAX_FILES} files allowed.`);
        return;
      }

      setUploadError(null);
      setUploading(true);

      try {
        const ext = file.name.split('.').pop() || 'txt';
        const storagePath = `${sessionId.current}/${crypto.randomUUID()}.${ext}`;

        const { error: uploadErr } = await supabase.storage
          .from('grant-uploads')
          .upload(storagePath, file, {
            contentType: file.type,
            upsert: false,
          });

        if (uploadErr) throw uploadErr;

        setUploadedFiles((prev) => [
          ...prev,
          {
            name: file.name,
            path: storagePath,
            size: file.size,
            type: file.type,
          },
        ]);
      } catch (err) {
        setUploadError(
          err instanceof Error ? err.message : 'Upload failed',
        );
      } finally {
        setUploading(false);
      }
    },
    [uploadedFiles],
  );

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      for (const f of Array.from(files)) uploadFile(f);
    }
    e.target.value = ''; // Reset input
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    if (files) {
      for (const f of Array.from(files)) uploadFile(f);
    }
  };

  const removeFile = async (path: string) => {
    await supabase.storage.from('grant-uploads').remove([path]);
    setUploadedFiles((prev) => prev.filter((f) => f.path !== path));
  };

  // Cleanup uploaded files on unmount
  useEffect(() => {
    return () => {
      if (uploadedFiles.length > 0) {
        const paths = uploadedFiles.map((f) => f.path);
        supabase.storage.from('grant-uploads').remove(paths).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Generate ────────────────────────────────────────────────────────────

  const generate = async () => {
    if (!funder || !mission.trim() || phase === 'generating' || phase === 'analyzing' || phase === 'researching') return;

    setOutput('');
    setPhase('analyzing');
    setError(null);
    setResearchStats(null);

    try {
      const headers = await getEdgeFunctionHeaders();
      const response = await fetch(GRANT_WRITER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          funder,
          mission,
          orgDetails,
          uploadedFilePaths: uploadedFiles.map((f) => f.path),
          sessionId: sessionId.current,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Server error (${response.status})`);
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let receivedText = false;

      while (true) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            if (receivedText) {
              setPhase('done');
            } else {
              setError('Generation completed but no output was received. Please try again.');
              setPhase('idle');
            }
            return;
          }
          try {
            const parsed = JSON.parse(data);

            // Phase updates from server
            if (parsed.phase === 'analyzing') setPhase('analyzing');
            else if (parsed.phase === 'researching') setPhase('researching');
            else if (parsed.phase === 'generating') setPhase('generating');

            // Research metadata
            if (parsed.researchComplete) {
              setResearchStats({
                statsFound: parsed.statsFound || 0,
                sourcesFound: parsed.sourcesFound || 0,
                fallback: parsed.fallback || false,
              });
            }

            // Text content
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text) {
              receivedText = true;
              setOutput((prev) => prev + parsed.text);
            }
          } catch (parseErr) {
            if (
              parseErr instanceof Error &&
              parseErr.message !== 'Unexpected end of JSON input'
            ) {
              throw parseErr;
            }
          }
        }
      }

      // If stream ended but no output was generated, treat as error
      if (!receivedText) {
        setError('Generation completed but no output was received. Please try again.');
        setPhase('idle');
      } else {
        setPhase('done');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate grant draft');
      setPhase('idle');
    }
  };

  const copyOutput = async () => {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const exportToWord = async () => {
    // Build a clean HTML document from the markdown output
    // Strip Tailwind classes from the rendered HTML since Word won't understand them
    const rawHtml = renderMarkdown(output);
    const cleanedHtml = rawHtml
      .replace(/ class="[^"]*"/g, '')
      .replace(/<div><\/div>/g, '<br>');
    const fullHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #000; margin: 0; padding: 0; }
  h2 { font-size: 15pt; font-weight: bold; color: #1a3a5c; margin: 18pt 0 6pt 0; padding: 0; }
  h3 { font-size: 12pt; font-weight: bold; color: #000; margin: 14pt 0 4pt 0; padding: 0; }
  p { font-size: 11pt; margin: 4pt 0; padding: 0; }
  strong { font-weight: bold; }
  hr { border: none; border-top: 1px solid #999; margin: 12pt 0; }
  span { font-size: 11pt; }
  div { font-size: 11pt; margin: 2pt 0; padding: 0; }
</style>
</head><body>${cleanedHtml}</body></html>`;

    try {
      const blob = await asBlob(fullHtml, {
        orientation: 'portrait' as const,
        margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      }) as Blob;

      const safeFileName = funder?.name
        ? `Grant_Draft_${funder.name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '_')}.docx`
        : 'Grant_Draft.docx';

      saveAs(blob, safeFileName);
    } catch (err) {
      console.error('Export to Word failed:', err);
    }
  };

  const reset = () => {
    setOutput('');
    setPhase('idle');
    setError(null);
    setResearchStats(null);
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  const inputClass =
    'w-full bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600';

  const labelClass = 'block text-xs text-gray-400 mb-1';

  const isProcessing =
    phase === 'analyzing' || phase === 'researching' || phase === 'generating';

  if (!funder) return null;

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />
      <div className="py-12 px-6">
      <div className="max-w-3xl mx-auto">
        {/* Back */}
        <button
          onClick={() => navigate('/saved')}
          className="flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors"
        >
          <ArrowLeft size={18} />
          Back to Saved Funders
        </button>

        {/* Page title */}
        <h1 className="text-3xl font-bold mb-1">AI Grant Writer</h1>
        <p className="text-gray-400 mb-8 text-sm">
          Generate a tailored, research-backed grant application draft powered
          by Claude.
        </p>

        {/* Funder context card */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-5 mb-7">
          <p className="text-xs text-gray-400 mb-1">Writing grant for</p>
          <h2 className="text-xl font-bold">{funder.name}</h2>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-400 mt-2">
            <span className="capitalize">{funder.type}</span>
            {funder.state && (
              <span>
                {funder.city ? `${funder.city}, ` : ''}
                {funder.state}
              </span>
            )}
            {(funder.grant_range_min || funder.grant_range_max) && (
              <span className="text-green-400">
                Grants: {formatGrantRange(funder)}
              </span>
            )}
            {funder.total_giving && (
              <span className="text-blue-400">
                {formatTotalGiving(funder.total_giving)} total giving
              </span>
            )}
          </div>
          {funder.focus_areas?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {funder.focus_areas.map((area, i) => (
                <span
                  key={i}
                  className="text-xs bg-[#21262d] border border-[#30363d] text-gray-300 px-2 py-0.5 rounded-full"
                >
                  {area}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* ── Form ── */}
        {!isProcessing && phase !== 'done' && (
          <div className="space-y-5">
            {/* Mission */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Mission Statement <span className="text-red-400">*</span>
              </label>
              <textarea
                className="w-full bg-[#161b22] border border-[#30363d] rounded-xl px-4 py-3 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 resize-none"
                rows={4}
                placeholder="Describe your nonprofit's mission and the communities you serve…"
                value={mission}
                onChange={(e) => setMission(e.target.value)}
              />
            </div>

            {/* ── Past Grants Upload (collapsible) ── */}
            <div className="border border-[#30363d] rounded-xl overflow-hidden">
              <button
                onClick={() => setShowPastGrants((p) => !p)}
                className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium hover:bg-[#161b22] transition-colors text-left"
              >
                <span className="text-gray-300">
                  Past Successful Grants{' '}
                  <span className="text-gray-400 font-normal">
                    (optional — matches your writing style)
                  </span>
                  {uploadedFiles.length > 0 && (
                    <span className="ml-2 text-xs bg-blue-600/20 text-blue-400 px-2 py-0.5 rounded-full">
                      {uploadedFiles.length} file{uploadedFiles.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </span>
                {showPastGrants ? (
                  <ChevronUp size={16} className="text-gray-400 shrink-0" />
                ) : (
                  <ChevronDown size={16} className="text-gray-400 shrink-0" />
                )}
              </button>

              {showPastGrants && (
                <div className="px-5 pb-5 bg-[#0d1117]">
                  <p className="text-xs text-gray-400 mb-3">
                    Upload 1–3 past successful grant proposals. The AI will
                    analyze your writing style, tone, and structure to match it
                    in the new draft. Files are used for this session only and
                    automatically deleted.
                  </p>

                  {/* Drag-drop zone */}
                  <div
                    className={`border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer ${
                      dragOver
                        ? 'border-blue-500 bg-blue-500/10'
                        : 'border-[#30363d] hover:border-gray-500'
                    }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload
                      size={24}
                      className="mx-auto mb-2 text-gray-400"
                    />
                    <p className="text-sm text-gray-300">
                      {uploading ? (
                        <span className="flex items-center justify-center gap-2">
                          <Loader2 size={14} className="animate-spin" />
                          Uploading…
                        </span>
                      ) : (
                        <>
                          Drop files here or{' '}
                          <span className="text-blue-400 underline">
                            browse
                          </span>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      PDF, DOCX, or TXT — max 10 MB each
                    </p>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept=".pdf,.docx,.txt"
                    multiple
                    onChange={handleFileSelect}
                  />

                  {/* Upload error */}
                  {uploadError && (
                    <div className="flex items-center gap-2 mt-3 text-sm text-red-400">
                      <X size={14} />
                      {uploadError}
                    </div>
                  )}

                  {/* Uploaded file list */}
                  {uploadedFiles.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {uploadedFiles.map((f) => (
                        <div
                          key={f.path}
                          className="flex items-center justify-between bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <FileText
                              size={16}
                              className="text-gray-400 shrink-0"
                            />
                            <div className="min-w-0">
                              <p className="text-sm text-gray-200 truncate">
                                {f.name}
                              </p>
                              <p className="text-xs text-gray-500">
                                {FILE_TYPE_LABELS[f.type] || 'File'} ·{' '}
                                {formatSize(f.size)}
                              </p>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFile(f.path);
                            }}
                            className="text-gray-500 hover:text-red-400 transition-colors shrink-0 ml-2"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Organization Details (collapsible) */}
            <div className="border border-[#30363d] rounded-xl overflow-hidden">
              <button
                onClick={() => setShowOrg((prev) => !prev)}
                className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium hover:bg-[#161b22] transition-colors text-left"
              >
                <span className="text-gray-300">
                  Organization Details{' '}
                  <span className="text-gray-400 font-normal">
                    (optional — improves quality)
                  </span>
                </span>
                {showOrg ? (
                  <ChevronUp size={16} className="text-gray-400 shrink-0" />
                ) : (
                  <ChevronDown size={16} className="text-gray-400 shrink-0" />
                )}
              </button>

              {showOrg && (
                <div className="px-5 pb-5 bg-[#0d1117] grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Organization Name</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Community Youth Alliance"
                      value={orgDetails.orgName}
                      onChange={(e) => updateOrg('orgName', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>
                      Annual Operating Budget
                    </label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. $500,000"
                      value={orgDetails.budget}
                      onChange={(e) => updateOrg('budget', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Target Population</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Youth ages 12–18 in low-income communities"
                      value={orgDetails.targetPop}
                      onChange={(e) => updateOrg('targetPop', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Geographic Focus</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Greater Boston, MA"
                      value={orgDetails.geoFocus}
                      onChange={(e) => updateOrg('geoFocus', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass}>
                      Organization Description
                    </label>
                    <textarea
                      className={`${inputClass} resize-none`}
                      rows={2}
                      placeholder="Brief description of your organization's history, programs, and impact…"
                      value={orgDetails.orgDesc}
                      onChange={(e) => updateOrg('orgDesc', e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Program Details (collapsible) */}
            <div className="border border-[#30363d] rounded-xl overflow-hidden">
              <button
                onClick={() => setShowProgram((prev) => !prev)}
                className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium hover:bg-[#161b22] transition-colors text-left"
              >
                <span className="text-gray-300">
                  Program / Project Details{' '}
                  <span className="text-gray-400 font-normal">
                    (optional — improves specificity)
                  </span>
                </span>
                {showProgram ? (
                  <ChevronUp size={16} className="text-gray-400 shrink-0" />
                ) : (
                  <ChevronDown size={16} className="text-gray-400 shrink-0" />
                )}
              </button>

              {showProgram && (
                <div className="px-5 pb-5 bg-[#0d1117] grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>
                      Program / Project Name
                    </label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Summer STEM Academy"
                      value={orgDetails.programName}
                      onChange={(e) =>
                        updateOrg('programName', e.target.value)
                      }
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Amount Requested</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. $50,000"
                      value={orgDetails.programBudget}
                      onChange={(e) =>
                        updateOrg('programBudget', e.target.value)
                      }
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Project Timeline</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. 12-month program, July 2025 – June 2026"
                      value={orgDetails.timeline}
                      onChange={(e) => updateOrg('timeline', e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Anticipated Outcomes</label>
                    <input
                      type="text"
                      className={inputClass}
                      placeholder="e.g. Serve 200 youth, 80% improve STEM skills"
                      value={orgDetails.outcomes}
                      onChange={(e) => updateOrg('outcomes', e.target.value)}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className={labelClass}>Program Description</label>
                    <textarea
                      className={`${inputClass} resize-none`}
                      rows={3}
                      placeholder="Describe the specific program or project you're seeking funding for…"
                      value={orgDetails.programDesc}
                      onChange={(e) =>
                        updateOrg('programDesc', e.target.value)
                      }
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Error */}
            {error && (
              <div className="bg-red-900/20 border border-red-800 rounded-xl px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            {/* Generate button */}
            <button
              onClick={generate}
              disabled={!mission.trim() || isProcessing}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-[#161b22] disabled:text-gray-600 disabled:cursor-not-allowed text-white font-semibold py-4 rounded-xl transition-colors text-base"
            >
              <Wand2 size={18} />
              Generate Grant Draft
            </button>

            <p className="text-xs text-gray-400 text-center">
              {uploadedFiles.length > 0
                ? `Style will match your ${uploadedFiles.length} uploaded grant${uploadedFiles.length !== 1 ? 's' : ''}. Deep research included automatically.`
                : 'Deep research included automatically. Upload past grants to match your writing style.'}
            </p>
          </div>
        )}

        {/* ── Progress indicator ── */}
        {isProcessing && !output && (
          <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6 space-y-4">
            <h3 className="text-sm font-medium text-gray-300 mb-4">
              Preparing your grant draft…
            </h3>

            {/* Phase: Analyzing past grants */}
            {uploadedFiles.length > 0 && (
              <div className="flex items-center gap-3">
                {phase === 'analyzing' ? (
                  <Loader2 size={16} className="animate-spin text-blue-400" />
                ) : (
                  <CheckCircle2 size={16} className="text-green-400" />
                )}
                <span
                  className={`text-sm ${
                    phase === 'analyzing'
                      ? 'text-blue-400'
                      : 'text-gray-400'
                  }`}
                >
                  Analyzing {uploadedFiles.length} past grant
                  {uploadedFiles.length !== 1 ? 's' : ''} for writing style…
                </span>
              </div>
            )}

            {/* Phase: Researching */}
            <div className="flex items-center gap-3">
              {phase === 'researching' ? (
                <Loader2 size={16} className="animate-spin text-blue-400" />
              ) : (['generating', 'done'] as string[]).includes(phase) ? (
                <CheckCircle2 size={16} className="text-green-400" />
              ) : (
                <div className="w-4 h-4 rounded-full border border-[#30363d]" />
              )}
              <span
                className={`text-sm ${
                  phase === 'researching'
                    ? 'text-blue-400'
                    : (['generating', 'done'] as string[]).includes(phase)
                    ? 'text-gray-400'
                    : 'text-gray-600'
                }`}
              >
                {researchStats
                  ? `Found ${researchStats.statsFound} statistics and ${researchStats.sourcesFound} sources${researchStats.fallback ? ' (using AI knowledge)' : ''}`
                  : 'Researching context, statistics, and trends…'}
              </span>
            </div>

            {/* Phase: Generating */}
            <div className="flex items-center gap-3">
              {phase === 'generating' ? (
                <Loader2 size={16} className="animate-spin text-blue-400" />
              ) : (
                <div className="w-4 h-4 rounded-full border border-[#30363d]" />
              )}
              <span
                className={`text-sm ${
                  phase === 'generating'
                    ? 'text-blue-400'
                    : 'text-gray-600'
                }`}
              >
                Writing your grant draft for {funder.name}…
              </span>
            </div>
          </div>
        )}

        {/* ── Streaming indicator (while text is flowing) ── */}
        {phase === 'generating' && output && (
          <div className="flex items-center gap-3 py-2 text-blue-400 text-sm">
            <Loader2 size={16} className="animate-spin" />
            Writing your grant application for {funder.name}…
          </div>
        )}

        {/* ── Output ── */}
        {output && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Your Grant Draft</h2>
              {phase === 'done' && (
                <div className="flex gap-2">
                  <button
                    onClick={exportToWord}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl px-4 py-2 text-sm font-medium transition-colors"
                  >
                    <Download size={14} />
                    Export to Word
                  </button>
                  <button
                    onClick={copyOutput}
                    className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
                  >
                    {copied ? (
                      <Check size={14} className="text-green-400" />
                    ) : (
                      <Copy size={14} />
                    )}
                    {copied ? 'Copied!' : 'Copy All'}
                  </button>
                  <button
                    onClick={reset}
                    className="flex items-center gap-2 border border-[#30363d] rounded-xl px-4 py-2 text-sm hover:bg-[#161b22] transition-colors"
                  >
                    <RefreshCw size={14} />
                    Re-generate
                  </button>
                </div>
              )}
            </div>

            {/* Research summary badge */}
            {researchStats && (
              <div className="flex items-center gap-2 mb-3 text-xs text-gray-400">
                <CheckCircle2 size={12} className="text-green-400" />
                Research-backed: {researchStats.statsFound} statistics,{' '}
                {researchStats.sourcesFound} sources integrated
                {researchStats.fallback && ' (AI knowledge)'}
              </div>
            )}

            <div
              className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(output) }}
            />

            {/* Scroll anchor + inline streaming indicator */}
            {phase === 'generating' && (
              <div className="flex items-center gap-2 mt-3 text-sm text-blue-400">
                <Loader2 size={14} className="animate-spin" />
                Generating…
              </div>
            )}
            <div ref={outputEndRef} />

            {phase === 'done' && (
              <p className="text-xs text-gray-300 text-center mt-4">
                Replace all [BRACKETS] with your organization's real data
                before submitting.
                {researchStats?.fallback &&
                  ' Verify AI-generated statistics with primary sources.'}
              </p>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
