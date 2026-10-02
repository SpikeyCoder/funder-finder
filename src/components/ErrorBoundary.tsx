import { Component, ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { isChunkLoadError, reloadOnceForChunkError, underlyingError } from '../lib/chunkReload';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  // True while an automatic chunk-error reload is in flight.
  reloading: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, reloading: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo);

    // For a failed chunk load, reloading pulls a fresh index.html plus valid
    // chunks and almost always recovers — so do it automatically, once. If
    // we've already tried, it isn't a transient load failure: show the error.
    if (isChunkLoadError(error) && reloadOnceForChunkError()) {
      this.setState({ reloading: true });
    }
  }

  handleTryAgain = () => {
    this.setState({ hasError: false, error: null, reloading: false });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      const shownError = this.state.error && underlyingError(this.state.error);
      // A recognised load failure we couldn't (or already did) auto-reload for
      // still gets the "reload" screen; anything else — e.g. a page module
      // that throws while loading — shows its real error.
      const reloadScreen = !this.state.reloading && isChunkLoadError(shownError);
      return (
        <div className="min-h-screen bg-[#0d1117] flex items-center justify-center px-4">
          <div className="max-w-md text-center">
            <div className="flex justify-center mb-6">
              <AlertCircle size={48} className="text-red-400" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-3">
              {this.state.reloading
                ? 'Reloading…'
                : reloadScreen ? 'A new version may be available' : 'Oops! Something went wrong'}
            </h1>
            <p className="text-gray-400 mb-6">
              {this.state.reloading
                ? 'Part of the page didn’t load. Fetching it again.'
                : reloadScreen
                  ? 'Part of the app didn’t load — usually because it was just updated. Reload to get the latest version.'
                  : 'We encountered an unexpected error. Please try again or contact support if the problem persists.'}
            </p>
            {!this.state.reloading && !reloadScreen && shownError && (
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
              onClick={this.handleTryAgain}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
            >
              {this.state.reloading || reloadScreen ? 'Reload' : 'Try Again'}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
