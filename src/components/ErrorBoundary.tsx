import { Component, ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { isChunkLoadError, reloadOnceForChunkError } from '../lib/chunkReload';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  // True while an automatic chunk-error reload is in flight.
  reloading: boolean;
}

const SCREEN_COPY = {
  reloading: {
    title: 'Reloading…',
    body: 'Part of the page didn’t load. Fetching it again.',
    button: 'Reload',
  },
  reload: {
    title: 'A new version may be available',
    body: 'Part of the app didn’t load — usually because it was just updated. Reload to get the latest version.',
    button: 'Reload',
  },
  error: {
    title: 'Oops! Something went wrong',
    body: 'We encountered an unexpected error. Please try again or contact support if the problem persists.',
    button: 'Try Again',
  },
};

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, reloading: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // componentDidCatch sets `reloading` again if this error starts a reload.
    return { hasError: true, error, reloading: false };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo);

    // For a failed chunk load, reloading pulls a fresh index.html plus valid
    // chunks and almost always recovers — so do it automatically, once. If
    // we've already tried, render() shows a manual Reload with the details.
    // The "Reloading…" screen keeps a Reload button, so if reload() is ever a
    // no-op (e.g. a sandboxed webview) nobody is stranded.
    if (isChunkLoadError(error) && reloadOnceForChunkError(error)) {
      this.setState({ reloading: true });
    }
  }

  handleTryAgain = () => {
    this.setState({ hasError: false, error: null, reloading: false });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const shownError = this.state.error;
      // While the automatic reload runs: "reloading". Afterwards, a chunk-load
      // failure still gets the manual "reload" screen (also when
      // sessionStorage is blocked and we couldn't auto-reload); anything else
      // shows its real error.
      const mode = this.state.reloading ? 'reloading' : isChunkLoadError(shownError) ? 'reload' : 'error';
      const copy = SCREEN_COPY[mode];
      return (
        <div className="min-h-screen bg-[#0d1117] flex items-center justify-center px-4">
          <div className="max-w-md text-center">
            <div className="flex justify-center mb-6">
              <AlertCircle size={48} className="text-red-400" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-3">{copy.title}</h1>
            <p className="text-gray-400 mb-6">{copy.body}</p>
            {mode !== 'reloading' && shownError && (
              <details className="mb-6 text-left bg-[#161b22] border border-[#30363d] rounded-lg p-4">
                <summary className="cursor-pointer text-sm text-gray-400 font-medium">
                  Error details
                </summary>
                <pre className="mt-3 text-xs text-gray-400 overflow-auto max-h-32">
                  {shownError.toString()}
                </pre>
              </details>
            )}
            <button
              // For a chunk error just reload: clearing the error first would
              // re-render the failed lazy route and throw (and log) again.
              onClick={mode === 'error' ? this.handleTryAgain : () => window.location.reload()}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
            >
              {copy.button}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
