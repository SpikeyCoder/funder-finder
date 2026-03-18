import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Bug, Loader2, Camera, CheckCircle, AlertCircle, Lightbulb } from 'lucide-react';
import { supabase, getEdgeFunctionHeaders } from '../lib/supabase';

const SUPABASE_URL = 'https://tgtotjvdubhjxzybmdex.supabase.co';

interface CapturedError {
  message: string;
  timestamp: number;
}

interface TechnicalContext {
  url: string;
  pageName: string;
  deviceType: string;
  userAgent: string;
  platform: string;
  viewportSize: string;
  screenSize: string;
  timestamp: string;
  recentErrors: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────

function getTechnicalContext(recentErrors: CapturedError[]): TechnicalContext {
  const isTouchDevice = navigator.maxTouchPoints > 0;
  return {
    url: window.location.href,
    pageName: document.title,
    deviceType: isTouchDevice ? 'Touch / Mobile' : 'Desktop',
    userAgent: navigator.userAgent,
    platform: navigator.platform || 'Unknown',
    viewportSize: `${window.innerWidth}×${window.innerHeight}`,
    screenSize: `${window.screen.width}×${window.screen.height}`,
    timestamp: new Date().toISOString(),
    recentErrors: recentErrors.map(
      (e) => `[${new Date(e.timestamp).toISOString()}] ${e.message}`,
    ),
  };
}

async function captureScreenshot(): Promise<Blob | null> {
  try {
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(document.body, {
      useCORS: true,
      scale: 1,
      logging: false,
      backgroundColor: '#0d1117',
    });
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png', 0.85);
    });
  } catch (err) {
    console.warn('Screenshot capture failed:', err);
    return null;
  }
}

async function uploadScreenshot(blob: Blob): Promise<string | null> {
  try {
    const fileName = `bug-reports/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const { error } = await supabase.storage
      .from('bug-screenshots')
      .upload(fileName, blob, { contentType: 'image/png' });

    if (error) throw error;

    const { data } = supabase.storage
      .from('bug-screenshots')
      .getPublicUrl(fileName);

    return data?.publicUrl || null;
  } catch (err) {
    console.warn('Screenshot upload failed:', err);
    return null;
  }
}

// ── Component ───────────────────────────────────────────────────────

export default function BugReportButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [isFeatureRequest, setIsFeatureRequest] = useState(false);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Pre-captured screenshot taken before the overlay opens
  const preScreenshotRef = useRef<Blob | null>(null);

  // Console error capture
  const errorsRef = useRef<CapturedError[]>([]);

  useEffect(() => {
    const originalError = console.error;
    const originalWarn = console.warn;

    const captureError = (msg: string) => {
      errorsRef.current.push({ message: msg.slice(0, 500), timestamp: Date.now() });
      if (errorsRef.current.length > 5) errorsRef.current.shift();
    };

    console.error = function (...args: unknown[]) {
      originalError.apply(console, args);
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      captureError(msg);
    };

    // Capture uncaught errors
    const handleError = (event: ErrorEvent) => {
      captureError(`${event.message} at ${event.filename}:${event.lineno}`);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
      captureError(`Unhandled Promise: ${msg}`);
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);

    return () => {
      console.error = originalError;
      console.warn = originalWarn;
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
    };
  }, []);

  const handleOpen = useCallback(async () => {
    // Capture the screenshot BEFORE the overlay is shown so it reflects
    // the actual page state the user sees when they click the bug button.
    preScreenshotRef.current = await captureScreenshot();
    setIsOpen(true);
    setSubmitStatus('idle');
    setErrorMessage('');
  }, []);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    setIsOpen(false);
    // Reset form after animation
    setTimeout(() => {
      setDescription('');
      setIsFeatureRequest(false);
      setIncludeScreenshot(true);
      setSubmitStatus('idle');
      setErrorMessage('');
      preScreenshotRef.current = null;
    }, 200);
  }, [isSubmitting]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitStatus('idle');
    setErrorMessage('');

    try {
      const context = getTechnicalContext(errorsRef.current);

      // Upload the pre-captured screenshot (taken before the overlay opened)
      let screenshotUrl: string | null = null;
      if (includeScreenshot && preScreenshotRef.current) {
        screenshotUrl = await uploadScreenshot(preScreenshotRef.current);
      }

      // Call edge function
      const headers = await getEdgeFunctionHeaders();
      const response = await fetch(`${SUPABASE_URL}/functions/v1/report-bug`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          description: description.trim(),
          isFeatureRequest,
          screenshotUrl,
          technicalContext: context,
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Server error (${response.status})`);
      }

      setSubmitStatus('success');
      // Auto-close after showing success
      setTimeout(() => handleClose(), 1800);
    } catch (err) {
      setSubmitStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to submit. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Floating Button ───────────────────────────────────────────────

  const floatingButton = (
    <button
      onClick={handleOpen}
      className="fixed bottom-6 right-6 z-40 bg-[#1f6feb] hover:bg-[#388bfd] text-white rounded-full p-3 shadow-lg shadow-black/40 transition-all duration-200 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-[#0d1117] group"
      aria-label="Report a bug or request a feature"
      title="Report a bug or request a feature"
    >
      <Bug size={20} />
    </button>
  );

  // ── Modal ─────────────────────────────────────────────────────────

  const modal = isOpen
    ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm px-4 pb-4 sm:items-center sm:pb-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          <div className="relative w-full max-w-md bg-[#161b22] border border-[#30363d] rounded-2xl p-6 shadow-2xl animate-[slideUp_0.2s_ease-out]">
            {/* Close button */}
            <button
              onClick={handleClose}
              disabled={isSubmitting}
              className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
              aria-label="Close"
            >
              <X size={18} />
            </button>

            {/* Header */}
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-blue-900/30 border border-blue-800/50 rounded-lg p-2">
                {isFeatureRequest ? (
                  <Lightbulb size={20} className="text-yellow-400" />
                ) : (
                  <Bug size={20} className="text-blue-400" />
                )}
              </div>
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {isFeatureRequest ? 'Feature Request' : 'Report a Bug'}
                </h2>
                <p className="text-xs text-gray-400">
                  We'll capture page details automatically
                </p>
              </div>
            </div>

            {/* Success state */}
            {submitStatus === 'success' ? (
              <div className="flex flex-col items-center py-8 gap-3">
                <CheckCircle size={40} className="text-green-400" />
                <p className="text-white font-medium">Report submitted!</p>
                <p className="text-gray-400 text-sm">
                  Thank you for helping us improve.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                {/* Description */}
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  What happened? <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={
                    isFeatureRequest
                      ? "Describe the feature you'd like to see..."
                      : 'Describe the bug or issue you experienced...'
                  }
                  required
                  rows={4}
                  maxLength={1000}
                  disabled={isSubmitting}
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-lg p-3 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-60"
                />
                <p className="text-xs text-gray-500 mt-1 text-right">
                  {description.length}/1000
                </p>

                {/* Options row */}
                <div className="flex flex-col gap-2.5 mt-3 mb-4">
                  <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={isFeatureRequest}
                      onChange={(e) => setIsFeatureRequest(e.target.checked)}
                      disabled={isSubmitting}
                      className="rounded border-[#30363d] bg-[#0d1117] text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                    />
                    This is a feature request
                  </label>

                  <label className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={includeScreenshot}
                      onChange={(e) => setIncludeScreenshot(e.target.checked)}
                      disabled={isSubmitting}
                      className="rounded border-[#30363d] bg-[#0d1117] text-blue-500 focus:ring-blue-500 focus:ring-offset-0 mt-0.5"
                    />
                    <span>
                      <Camera size={14} className="inline mr-1 opacity-60" />
                      Include a screenshot
                      <span className="block text-xs text-gray-500">
                        Captures the visible page content
                      </span>
                    </span>
                  </label>
                </div>

                {/* Error message */}
                {submitStatus === 'error' && (
                  <div className="flex items-center gap-2 bg-red-900/20 border border-red-800/40 rounded-lg p-3 mb-3">
                    <AlertCircle size={16} className="text-red-400 flex-shrink-0" />
                    <p className="text-xs text-red-300">{errorMessage}</p>
                  </div>
                )}

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={!description.trim() || isSubmitting}
                  className="w-full bg-[#1f6feb] hover:bg-[#388bfd] text-white font-medium rounded-lg py-2.5 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      {includeScreenshot ? 'Capturing & submitting...' : 'Submitting...'}
                    </>
                  ) : (
                    'Submit Report'
                  )}
                </button>
              </form>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {floatingButton}
      {modal}
    </>
  );
}
