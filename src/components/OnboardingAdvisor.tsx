/**
 * OnboardingAdvisor — collapsible chat panel for AI-powered grant strategy
 * guidance during onboarding.
 *
 * Wires into the `onboarding-advisor` edge function (PR #178). Designed to
 * sit alongside the existing OnboardingPage form, not replace it.
 *
 * Follows the same chat patterns established in ConversationalProjectSetup.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Lightbulb,
  Loader,
  MessageCircle,
  ArrowUp,
  Sparkles,
  FolderPlus,
} from 'lucide-react';
import {
  callOnboardingAdvisor,
  type AdvisorMessage,
  type AdvisorTip,
  type OrgProfile,
} from '../lib/onboardingAdvisor';

// ── Props ────────────────────────────────────────────────────────────────

interface OnboardingAdvisorProps {
  /** Current onboarding step (0-based: 0=Welcome, 1=Profile, 2=Project, 3=Matches) */
  step: 0 | 1 | 2 | 3;
  /** Current org profile state from the onboarding form */
  profile: Partial<OrgProfile>;
  /** Called when the advisor says the user is ready to create their first project */
  onCreateProject?: () => void;
}

// ── Component ────────────────────────────────────────────────────────────

export default function OnboardingAdvisor({
  step,
  profile,
  onCreateProject,
}: OnboardingAdvisorProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<AdvisorMessage[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [tips, setTips] = useState<AdvisorTip[]>([]);
  const [composerValue, setComposerValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyToProceed, setReadyToProceed] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to latest message
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading, tips]);

  // Focus input when panel expands
  useEffect(() => {
    if (isExpanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isExpanded]);

  // Send a request to the advisor edge function
  const callAdvisor = useCallback(
    async (nextMessages: AdvisorMessage[]) => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await callOnboardingAdvisor(nextMessages, profile, step);

        setMessages([
          ...nextMessages,
          { role: 'assistant', content: data.reply },
        ]);
        setChips(data.chips || []);
        setTips(data.tips || []);
        setReadyToProceed(data.ready_to_proceed);
      } catch (err: unknown) {
        const msg =
          err instanceof Error ? err.message : 'Could not reach the advisor.';
        setError(msg);
      } finally {
        setIsLoading(false);
      }
    },
    [profile, step],
  );

  // Initialize with a greeting when the panel is first expanded
  const handleToggle = () => {
    const next = !isExpanded;
    setIsExpanded(next);
    if (next && !hasInitialized) {
      setHasInitialized(true);
      callAdvisor([]);
    }
  };

  // Send a user message (from input or chip click)
  const sendMessage = (content: string) => {
    if (!content.trim() || isLoading) return;
    const nextMessages: AdvisorMessage[] = [
      ...messages,
      { role: 'user', content: content.trim() },
    ];
    setMessages(nextMessages);
    setComposerValue('');
    setChips([]);
    setTips([]);
    callAdvisor(nextMessages);
  };

  const onChipClick = (chip: string) => sendMessage(chip);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(composerValue);
  };

  // ── Collapsed state ──────────────────────────────────────────────────

  if (!isExpanded) {
    return (
      <button
        onClick={handleToggle}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl shadow-lg shadow-blue-600/20 transition-all hover:scale-105"
        aria-label="Open onboarding advisor"
      >
        <MessageCircle size={18} />
        <span className="text-sm font-medium">Grant Strategy Advisor</span>
        <ChevronUp size={16} />
      </button>
    );
  }

  // ── Expanded panel ──────────────────────────────────────────────────

  return (
    <div className="fixed bottom-6 right-6 z-50 w-96 max-h-[600px] bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl shadow-black/40 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] bg-[#161b22]">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center">
            <Sparkles size={12} className="text-white" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Grant Strategy Advisor</p>
            <p className="text-[10px] text-gray-400">Powered by AI</p>
          </div>
        </div>
        <button
          onClick={handleToggle}
          className="text-gray-400 hover:text-white p-1 rounded transition-colors"
          aria-label="Collapse advisor panel"
        >
          <ChevronDown size={18} />
        </button>
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
        style={{ minHeight: 200, maxHeight: 380 }}
      >
        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === 'assistant' ? (
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center flex-none mt-0.5">
                  <Sparkles size={10} className="text-white" />
                </div>
                <div className="bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2.5 text-sm text-white max-w-[300px] leading-relaxed">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="flex justify-end">
                <div className="bg-blue-600 rounded-xl px-3 py-2.5 text-sm text-white max-w-[260px]">
                  {msg.content}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center flex-none">
              <Sparkles size={10} className="text-white" />
            </div>
            <span className="inline-flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse" />
              <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse [animation-delay:120ms]" />
              <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-pulse [animation-delay:240ms]" />
            </span>
          </div>
        )}

        {/* Suggestion chips */}
        {!isLoading && chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 ml-8">
            {chips.map((chip) => (
              <button
                key={chip}
                onClick={() => onChipClick(chip)}
                className="text-xs font-medium bg-[#0d1117] border border-[#484f58] hover:border-blue-500 text-white px-2.5 py-1.5 rounded-full transition-colors"
              >
                {chip}
              </button>
            ))}
          </div>
        )}

        {/* Tips */}
        {!isLoading && tips.length > 0 && (
          <div className="space-y-2 ml-8">
            {tips.map((tip, i) => (
              <div
                key={i}
                className="flex items-start gap-2 bg-yellow-950/30 border border-yellow-700/40 rounded-lg px-3 py-2"
              >
                <Lightbulb
                  size={14}
                  className="text-yellow-400 flex-none mt-0.5"
                />
                <p className="text-xs text-yellow-200/90 leading-relaxed">
                  {tip.text}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Ready-to-proceed CTA */}
        {readyToProceed && !isLoading && (
          <div className="ml-8">
            <button
              onClick={onCreateProject}
              className="flex items-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition-colors w-full justify-center"
            >
              <FolderPlus size={16} />
              Create my first project
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="ml-8 bg-red-950/40 border border-red-700/60 text-red-300 px-3 py-2 rounded-lg text-xs">
            {error}
            <button
              onClick={() => callAdvisor(messages)}
              className="block mt-1 text-red-400 hover:text-red-300 underline text-[11px]"
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {/* Composer */}
      <form
        onSubmit={onSubmit}
        className="border-t border-[#30363d] px-3 py-2.5 flex items-center gap-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={composerValue}
          onChange={(e) => setComposerValue(e.target.value)}
          placeholder="Ask about grant strategy..."
          className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
          disabled={isLoading}
          aria-label="Message to onboarding advisor"
        />
        <button
          type="submit"
          disabled={!composerValue.trim() || isLoading}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white w-8 h-8 rounded-lg flex items-center justify-center flex-none transition-colors"
          aria-label="Send message"
        >
          {isLoading ? (
            <Loader size={14} className="animate-spin" />
          ) : (
            <ArrowUp size={14} />
          )}
        </button>
      </form>
    </div>
  );
}
