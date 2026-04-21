/**
 * MigrationImportPage.tsx
 *
 * 1-click import flow: Upload → Auto-detect platform → Preview data →
 * Select conflict resolution → Confirm → Import into saved funders & pipeline.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Loader2,
  ArrowLeft, ArrowRight, Eye, Download, RefreshCw, SkipForward,
  Copy, ChevronDown, ChevronUp,
} from 'lucide-react';
import NavBar from '../components/NavBar';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import {
  parseImportFile,
  matchFundersByEin,
  matchFundersByName,
  type ParseResult,
  type SourcePlatform,
} from '../utils/migrationParsers';

// ── Constants ───────────────────────────────────────────────────────────────

type ConflictStrategy = 'skip' | 'overwrite' | 'keep_both';
type ImportTarget = 'saved_funders' | 'tracked_grants' | 'both';
type ImportStep = 'upload' | 'preview' | 'options' | 'importing' | 'done';

const PLATFORM_LABELS: Record<SourcePlatform, string> = {
  instrumentl: 'Instrumentl',
  candid: 'Candid (Foundation Directory)',
  grantstation: 'GrantStation',
  generic_csv: 'Generic CSV / Excel',
};

const PLATFORM_COLORS: Record<SourcePlatform, string> = {
  instrumentl: 'text-blue-400 bg-blue-900/30 border-blue-700',
  candid: 'text-emerald-400 bg-emerald-900/30 border-emerald-700',
  grantstation: 'text-purple-400 bg-purple-900/30 border-purple-700',
  generic_csv: 'text-gray-400 bg-gray-800/40 border-gray-600',
};

const CONFLICT_OPTIONS: { key: ConflictStrategy; label: string; desc: string }[] = [
  { key: 'skip', label: 'Skip duplicates', desc: 'Keep existing records, skip any imported records that match by EIN or name.' },
  { key: 'overwrite', label: 'Overwrite existing', desc: 'Replace existing records with imported data where EIN or name matches.' },
  { key: 'keep_both', label: 'Keep both', desc: 'Import all records even if duplicates exist. You can merge them later.' },
];

const TARGET_OPTIONS: { key: ImportTarget; label: string; desc: string }[] = [
  { key: 'saved_funders', label: 'Saved Funders only', desc: 'Add imported funders to your saved funders list.' },
  { key: 'tracked_grants', label: 'Pipeline only', desc: 'Add as tracked grants in a project pipeline (requires selecting a project).' },
  { key: 'both', label: 'Both', desc: 'Add to saved funders AND create pipeline entries in a project.' },
];

// ── Component ───────────────────────────────────────────────────────────────

export default function MigrationImportPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  // Step state
  const [step, setStep] = useState<ImportStep>('upload');

  // Upload / parse state
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Options state
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>('skip');
  const [importTarget, setImportTarget] = useState<ImportTarget>('saved_funders');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);

  // Import progress
  const [importProgress, setImportProgress] = useState({ imported: 0, skipped: 0, errors: 0, total: 0 });
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [, setImportJobId] = useState<string | null>(null);

  // Preview expansion
  const [previewExpanded, setPreviewExpanded] = useState(false);

  // Page title
  useEffect(() => {
    document.title = 'Import Data | FunderMatch';
  }, []);

  // Load user projects when needed
  useEffect(() => {
    if (!user) return;
    if (importTarget === 'tracked_grants' || importTarget === 'both') {
      loadProjects();
    }
  }, [user, importTarget]);

  const loadProjects = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('projects')
      .select('id, name')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (data) {
      setProjects(data);
      if (data.length > 0 && !selectedProjectId) setSelectedProjectId(data[0].id);
    }
  };

  // ── File handling ───────────────────────────────────────────────────────────

  const onFileSelect = useCallback(async (selectedFile: File) => {
    setFile(selectedFile);
    setParsing(true);
    setParseError(null);
    setParseResult(null);

    try {
      const result = await parseImportFile(selectedFile);
      setParseResult(result);

      if (result.records.length === 0 && result.errors.length > 0) {
        setParseError(result.errors[0]);
      } else if (result.records.length === 0) {
        // No records parsed and no explicit errors — column headers didn't match
        const expectedCols = 'Funder Name, Foundation Name, Organization Name, or Name';
        setParseError(
          `No matching data found. Make sure your spreadsheet has a column named ${expectedCols}. ` +
          `Detected columns: ${result.headers.slice(0, 8).join(', ')}${result.headers.length > 8 ? '...' : ''}`
        );
      } else {
        setStep('preview');
      }
    } catch (e: any) {
      setParseError(e.message || 'Failed to parse file.');
    } finally {
      setParsing(false);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onFileSelect(f);
  }, [onFileSelect]);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onFileSelect(f);
  }, [onFileSelect]);

  // ── Import execution ──────────────────────────────────────────────────────

  const executeImport = async () => {
    if (!parseResult || !user) return;

    setStep('importing');
    const records = parseResult.records;
    const total = records.length;
    setImportProgress({ imported: 0, skipped: 0, errors: 0, total });
    setImportErrors([]);

    // Create import job record
    const { data: jobData } = await supabase
      .from('import_jobs')
      .insert({
        user_id: user.id,
        source_platform: parseResult.platform,
        file_name: file?.name ?? 'unknown',
        status: 'processing',
        total_rows: total,
        conflict_strategy: conflictStrategy,
        import_target: importTarget,
        project_id: selectedProjectId,
      })
      .select('id')
      .single();

    const jobId = jobData?.id;
    if (jobId) setImportJobId(jobId);

    // EIN-based matching
    const eins = records.map(r => r.ein).filter((e): e is string => e !== null);
    const einMap = await matchFundersByEin(eins, supabase);

    // Name-based matching for records without EIN matches
    const unmatchedNames = records
      .filter(r => !r.ein || !einMap.has(r.ein))
      .map(r => r.funderName);
    const nameMap = await matchFundersByName(unmatchedNames, supabase);

    // Fetch existing saved funder IDs for conflict detection
    const { data: existingSaved } = await supabase
      .from('saved_funders')
      .select('funder_id, funder_data')
      .eq('user_id', user.id);
    const existingSavedIds = new Set((existingSaved ?? []).map((s: any) => s.funder_id));

    // Get default pipeline status if importing to tracked grants
    let defaultStatusId: string | null = null;
    if (importTarget === 'tracked_grants' || importTarget === 'both') {
      const { data: statuses } = await supabase
        .from('pipeline_statuses')
        .select('id')
        .eq('user_id', user.id)
        .eq('is_default', true)
        .limit(1);
      if (statuses && statuses.length > 0) {
        defaultStatusId = statuses[0].id;
      } else {
        // Fallback: get first status
        const { data: fallback } = await supabase
          .from('pipeline_statuses')
          .select('id')
          .eq('user_id', user.id)
          .order('sort_order')
          .limit(1);
        defaultStatusId = fallback?.[0]?.id ?? null;
      }
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    const errorDetails: string[] = [];

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];

      try {
        // Resolve funder ID via EIN or name
        const einMatch = rec.ein ? einMap.get(rec.ein) : undefined;
        const nameMatch = !einMatch ? nameMap.get(rec.funderName.toLowerCase()) : undefined;
        const matchedFunder = einMatch || nameMatch;

        const funderId = matchedFunder?.id ?? `imported-${rec.source}-${Date.now()}-${i}`;
        const isExisting = existingSavedIds.has(funderId);

        // Conflict resolution
        if (isExisting && conflictStrategy === 'skip') {
          skipped++;
          setImportProgress(p => ({ ...p, skipped: p.skipped + 1 }));
          continue;
        }

        // Build funder_data JSONB for saved_funders
        const funderData = {
          id: funderId,
          name: rec.funderName,
          type: 'foundation',
          foundation_ein: rec.ein,
          description: null,
          focus_areas: rec.focusAreas,
          city: rec.city,
          state: rec.state,
          website: rec.website,
          total_giving: rec.totalGiving,
          asset_amount: rec.assetAmount,
          contact_name: rec.contactName,
          contact_email: rec.contactEmail,
          grant_range_min: null,
          grant_range_max: null,
        };

        // Import to saved funders
        if (importTarget === 'saved_funders' || importTarget === 'both') {
          if (isExisting && conflictStrategy === 'overwrite') {
            await supabase
              .from('saved_funders')
              .update({
                funder_data: funderData,
                status: rec.status,
                notes: rec.notes || null,
              })
              .eq('user_id', user.id)
              .eq('funder_id', funderId);
          } else {
            await supabase
              .from('saved_funders')
              .upsert({
                user_id: user.id,
                funder_id: funderId,
                funder_data: funderData,
                status: rec.status,
                notes: rec.notes || null,
              }, { onConflict: 'user_id,funder_id' });
          }
        }

        // Import to tracked grants (pipeline)
        if ((importTarget === 'tracked_grants' || importTarget === 'both') && selectedProjectId && defaultStatusId) {
          await supabase
            .from('tracked_grants')
            .insert({
              project_id: selectedProjectId,
              user_id: user.id,
              funder_ein: rec.ein,
              funder_name: rec.funderName,
              grant_title: rec.grantTitle,
              status_id: defaultStatusId,
              amount: rec.amount,
              deadline: rec.deadline,
              grant_url: rec.grantUrl,
              notes: rec.notes || null,
              source: `import:${rec.source}`,
              is_external: true,
            });
        }

        imported++;
        existingSavedIds.add(funderId);
        setImportProgress(p => ({ ...p, imported: p.imported + 1 }));
      } catch (e: any) {
        errors++;
        const msg = `Row ${i + 1} (${rec.funderName}): ${e.message || 'Unknown error'}`;
        errorDetails.push(msg);
        setImportProgress(p => ({ ...p, errors: p.errors + 1 }));
      }
    }

    setImportErrors(errorDetails);

    // Update import job
    if (jobId) {
      await supabase
        .from('import_jobs')
        .update({
          status: errors > 0 && imported === 0 ? 'failed' : 'completed',
          imported_count: imported,
          skipped_count: skipped,
          error_count: errors,
          error_details: errorDetails,
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);
    }

    setStep('done');
  };

  // ── Reset ─────────────────────────────────────────────────────────────────

  const resetImport = () => {
    setStep('upload');
    setFile(null);
    setParseResult(null);
    setParseError(null);
    setImportProgress({ imported: 0, skipped: 0, errors: 0, total: 0 });
    setImportErrors([]);
    setImportJobId(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0d1117] text-white">
      <NavBar />
      <div className="max-w-4xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center gap-2 text-gray-400 hover:text-white text-sm mb-4 transition-colors"
          >
            <ArrowLeft size={16} /> Back
          </button>
          <h1 className="text-2xl font-bold">Import Data</h1>
          <p className="text-gray-400 mt-1">
            Import your saved funders, grant prospects, and application history from other platforms.
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-8">
          {(['upload', 'preview', 'options', 'importing', 'done'] as ImportStep[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border ${
                step === s ? 'bg-blue-600 border-blue-500 text-white' :
                (['upload', 'preview', 'options', 'importing', 'done'].indexOf(step) > i)
                  ? 'bg-green-900/40 border-green-700 text-green-400'
                  : 'bg-gray-800 border-gray-600 text-gray-500'
              }`}>
                {(['upload', 'preview', 'options', 'importing', 'done'].indexOf(step) > i) ? (
                  <CheckCircle2 size={16} />
                ) : (
                  i + 1
                )}
              </div>
              {i < 4 && <div className="w-8 h-px bg-gray-700" />}
            </div>
          ))}
          <span className="text-xs text-gray-500 ml-2">
            {step === 'upload' && 'Upload file'}
            {step === 'preview' && 'Preview data'}
            {step === 'options' && 'Import options'}
            {step === 'importing' && 'Importing...'}
            {step === 'done' && 'Complete'}
          </span>
        </div>

        {/* ── Step 1: Upload ─────────────────────────────────────────── */}
        {step === 'upload' && (
          <div className="space-y-6">
            {/* Supported platforms */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(Object.entries(PLATFORM_LABELS) as [SourcePlatform, string][]).map(([key, label]) => (
                <div key={key} className={`p-4 rounded-lg border ${PLATFORM_COLORS[key]}`}>
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet size={18} />
                    <span className="font-medium text-sm">{label}</span>
                  </div>
                  <p className="text-xs mt-1 opacity-70">
                    {key === 'instrumentl' && 'Export your Tracker or Awards as CSV from Instrumentl'}
                    {key === 'candid' && 'Export funder profiles from Foundation Directory'}
                    {key === 'grantstation' && 'Export saved opportunities from GrantStation'}
                    {key === 'generic_csv' && 'Any CSV or Excel file with funder/grant data'}
                  </p>
                </div>
              ))}
            </div>

            {/* Drop zone */}
            <div
              onDrop={onDrop}
              onDragOver={e => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-gray-600 hover:border-blue-500 rounded-xl p-12 text-center cursor-pointer transition-colors"
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.xlsx,.xls"
                onChange={onFileInput}
                className="hidden"
              />
              {parsing ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 size={32} className="text-blue-400 animate-spin" />
                  <p className="text-gray-300">Parsing file...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Upload size={32} className="text-gray-500" />
                  <p className="text-gray-300">Drop a CSV or Excel file here, or click to browse</p>
                  <p className="text-xs text-gray-500">Supports .csv, .tsv, .xlsx, .xls</p>
                </div>
              )}
            </div>

            {/* Parse error */}
            {parseError && (
              <div className="flex items-start gap-3 p-4 bg-red-900/20 border border-red-800 rounded-lg">
                <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-red-300 font-medium">Failed to parse file</p>
                  <p className="text-xs text-red-400 mt-1">{parseError}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Preview ────────────────────────────────────────── */}
        {step === 'preview' && parseResult && (
          <div className="space-y-6">
            {/* Detection banner */}
            <div className={`flex items-center justify-between p-4 rounded-lg border ${PLATFORM_COLORS[parseResult.platform]}`}>
              <div className="flex items-center gap-3">
                <FileSpreadsheet size={20} />
                <div>
                  <p className="font-medium text-sm">
                    Detected: {PLATFORM_LABELS[parseResult.platform]}
                  </p>
                  <p className="text-xs opacity-70 mt-0.5">
                    {parseResult.records.length} records found &middot; {file?.name}
                  </p>
                </div>
              </div>
              <button onClick={resetImport} className="text-xs opacity-70 hover:opacity-100 transition-opacity">
                Choose different file
              </button>
            </div>

            {/* Parse warnings */}
            {parseResult.errors.length > 0 && (
              <div className="p-4 bg-amber-900/20 border border-amber-800 rounded-lg">
                <p className="text-sm text-amber-300 font-medium flex items-center gap-2">
                  <AlertCircle size={16} /> {parseResult.errors.length} row(s) had parse issues
                </p>
                <div className="mt-2 max-h-32 overflow-y-auto">
                  {parseResult.errors.slice(0, 10).map((e, i) => (
                    <p key={i} className="text-xs text-amber-400">{e}</p>
                  ))}
                  {parseResult.errors.length > 10 && (
                    <p className="text-xs text-amber-500 mt-1">...and {parseResult.errors.length - 10} more</p>
                  )}
                </div>
              </div>
            )}

            {/* Data preview table */}
            <div className="bg-[#161b22] border border-[#30363d] rounded-lg overflow-hidden">
              <div
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-white/[0.02]"
                onClick={() => setPreviewExpanded(!previewExpanded)}
              >
                <span className="text-sm font-medium flex items-center gap-2">
                  <Eye size={16} /> Preview imported data
                </span>
                {previewExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </div>

              {previewExpanded && (
                <div className="overflow-x-auto border-t border-[#30363d]">
                  <table className="w-full text-xs">
                    <thead className="bg-[#0d1117]">
                      <tr>
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">#</th>
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">Funder Name</th>
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">EIN</th>
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">Grant Title</th>
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">Status</th>
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">Amount</th>
                        <th className="px-3 py-2 text-left text-gray-400 font-medium">Deadline</th>
                      </tr>
                    </thead>
                    <tbody>
                      {parseResult.records.slice(0, 50).map((rec, i) => (
                        <tr key={i} className="border-t border-[#21262d] hover:bg-white/[0.02]">
                          <td className="px-3 py-2 text-gray-500">{i + 1}</td>
                          <td className="px-3 py-2 text-gray-200 max-w-[200px] truncate">{rec.funderName}</td>
                          <td className="px-3 py-2 text-gray-400 font-mono">{rec.ein || '—'}</td>
                          <td className="px-3 py-2 text-gray-300 max-w-[180px] truncate">{rec.grantTitle || '—'}</td>
                          <td className="px-3 py-2">
                            <StatusBadge status={rec.status} />
                          </td>
                          <td className="px-3 py-2 text-gray-300">{rec.amount ? `$${rec.amount.toLocaleString()}` : '—'}</td>
                          <td className="px-3 py-2 text-gray-400">{rec.deadline || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {parseResult.records.length > 50 && (
                    <p className="text-xs text-gray-500 p-3 border-t border-[#21262d]">
                      Showing 50 of {parseResult.records.length} records
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Total records" value={parseResult.records.length} />
              <StatCard label="With EIN" value={parseResult.records.filter(r => r.ein).length} />
              <StatCard label="With deadline" value={parseResult.records.filter(r => r.deadline).length} />
              <StatCard label="With amount" value={parseResult.records.filter(r => r.amount).length} />
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={resetImport}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-600 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setStep('options')}
                className="px-6 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors flex items-center gap-2"
              >
                Continue <ArrowRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Options ────────────────────────────────────────── */}
        {step === 'options' && (
          <div className="space-y-6">
            {/* Import target */}
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Import destination</h3>
              <div className="space-y-2">
                {TARGET_OPTIONS.map(opt => (
                  <label
                    key={opt.key}
                    className={`flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-colors ${
                      importTarget === opt.key
                        ? 'border-blue-600 bg-blue-900/10'
                        : 'border-[#30363d] hover:border-gray-500'
                    }`}
                  >
                    <input
                      type="radio"
                      name="target"
                      checked={importTarget === opt.key}
                      onChange={() => setImportTarget(opt.key)}
                      className="mt-1"
                    />
                    <div>
                      <p className="text-sm font-medium">{opt.label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Project selector (when pipeline is a target) */}
            {(importTarget === 'tracked_grants' || importTarget === 'both') && (
              <div>
                <h3 className="text-sm font-medium text-gray-300 mb-3">Select project</h3>
                {projects.length === 0 ? (
                  <div className="p-4 bg-amber-900/20 border border-amber-800 rounded-lg">
                    <p className="text-sm text-amber-300">No projects found. Please create a project first to import into the pipeline.</p>
                    <button
                      onClick={() => navigate('/projects/new')}
                      className="mt-2 text-xs text-blue-400 hover:text-blue-300"
                    >
                      Create a project &rarr;
                    </button>
                  </div>
                ) : (
                  <select
                    value={selectedProjectId ?? ''}
                    onChange={e => setSelectedProjectId(e.target.value)}
                    className="w-full bg-[#161b22] border border-[#30363d] rounded-lg px-4 py-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none"
                  >
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* Conflict strategy */}
            <div>
              <h3 className="text-sm font-medium text-gray-300 mb-3">Duplicate handling</h3>
              <div className="space-y-2">
                {CONFLICT_OPTIONS.map(opt => (
                  <label
                    key={opt.key}
                    className={`flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-colors ${
                      conflictStrategy === opt.key
                        ? 'border-blue-600 bg-blue-900/10'
                        : 'border-[#30363d] hover:border-gray-500'
                    }`}
                  >
                    <input
                      type="radio"
                      name="conflict"
                      checked={conflictStrategy === opt.key}
                      onChange={() => setConflictStrategy(opt.key)}
                      className="mt-1"
                    />
                    <div>
                      <p className="text-sm font-medium flex items-center gap-2">
                        {opt.key === 'skip' && <SkipForward size={14} />}
                        {opt.key === 'overwrite' && <RefreshCw size={14} />}
                        {opt.key === 'keep_both' && <Copy size={14} />}
                        {opt.label}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setStep('preview')}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-600 rounded-lg transition-colors flex items-center gap-2"
              >
                <ArrowLeft size={16} /> Back
              </button>
              <button
                onClick={executeImport}
                disabled={(importTarget !== 'saved_funders') && !selectedProjectId}
                className="px-6 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
              >
                <Download size={16} /> Import {parseResult?.records.length} records
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Importing ──────────────────────────────────────── */}
        {step === 'importing' && (
          <div className="flex flex-col items-center py-16">
            <Loader2 size={40} className="text-blue-400 animate-spin mb-4" />
            <p className="text-lg font-medium">Importing data...</p>
            <p className="text-sm text-gray-400 mt-2">
              {importProgress.imported + importProgress.skipped + importProgress.errors} / {importProgress.total} processed
            </p>
            <div className="w-64 bg-gray-800 rounded-full h-2 mt-4 overflow-hidden">
              <div
                className="bg-blue-500 h-full rounded-full transition-all duration-200"
                style={{ width: `${importProgress.total ? ((importProgress.imported + importProgress.skipped + importProgress.errors) / importProgress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="flex gap-6 mt-4 text-xs text-gray-400">
              <span className="text-green-400">{importProgress.imported} imported</span>
              <span className="text-amber-400">{importProgress.skipped} skipped</span>
              {importProgress.errors > 0 && <span className="text-red-400">{importProgress.errors} errors</span>}
            </div>
          </div>
        )}

        {/* ── Step 5: Done ───────────────────────────────────────────── */}
        {step === 'done' && (
          <div className="space-y-6">
            <div className="flex flex-col items-center py-12">
              <CheckCircle2 size={48} className="text-green-400 mb-4" />
              <h2 className="text-xl font-bold">Import complete!</h2>
              <p className="text-sm text-gray-400 mt-2">
                Successfully imported {importProgress.imported} record{importProgress.imported !== 1 ? 's' : ''} from {PLATFORM_LABELS[parseResult?.platform ?? 'generic_csv']}.
              </p>
            </div>

            {/* Results summary */}
            <div className="grid grid-cols-3 gap-3">
              <StatCard label="Imported" value={importProgress.imported} color="text-green-400" />
              <StatCard label="Skipped" value={importProgress.skipped} color="text-amber-400" />
              <StatCard label="Errors" value={importProgress.errors} color={importProgress.errors > 0 ? 'text-red-400' : 'text-gray-400'} />
            </div>

            {/* Error details */}
            {importErrors.length > 0 && (
              <div className="p-4 bg-red-900/20 border border-red-800 rounded-lg">
                <p className="text-sm text-red-300 font-medium mb-2">Import errors:</p>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {importErrors.map((e, i) => (
                    <p key={i} className="text-xs text-red-400">{e}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3 justify-center">
              <button
                onClick={resetImport}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-600 rounded-lg transition-colors"
              >
                Import another file
              </button>
              <button
                onClick={() => navigate('/saved')}
                className="px-6 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
              >
                View Saved Funders
              </button>
              {(importTarget === 'tracked_grants' || importTarget === 'both') && selectedProjectId && (
                <button
                  onClick={() => navigate(`/projects/${selectedProjectId}/tracker`)}
                  className="px-6 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
                >
                  View Pipeline
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Small components ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    researching: 'text-blue-300 bg-blue-900/30',
    applied: 'text-amber-300 bg-amber-900/30',
    awarded: 'text-green-300 bg-green-900/30',
    passed: 'text-gray-400 bg-gray-800/40',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${styles[status] ?? styles.researching}`}>
      {status}
    </span>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-[#161b22] border border-[#30363d] rounded-lg p-4 text-center">
      <p className={`text-2xl font-bold ${color ?? 'text-white'}`}>{value.toLocaleString()}</p>
      <p className="text-xs text-gray-400 mt-1">{label}</p>
    </div>
  );
}
