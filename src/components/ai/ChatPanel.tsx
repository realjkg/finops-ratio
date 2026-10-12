import Link from 'next/link';
import { FRANK } from '@/agent-workflows/frank';
// ChatPanel (Wave3b) — collapsible AI chat drawer, anchored right. Closed: a
// floating launcher button; open: a 340px panel with quick prompts, the scrolling
// conversation, a thinking indicator, and the input. Rendered as a fixed overlay
// so it sits identically over the executive (light) and technical (dark) surfaces,
// using the shared dark surface + purple AI tokens — no per-surface theme logic.
// Voice (Wave4): the input carries a dictation mic (see ChatInput) and the header
// a spoken-replies toggle (see useSpokenReplies) — browser-native Web Speech, no
// backend, no keys; hidden entirely where the API is unavailable.
//
// A11y (spec §7.4): <aside aria-label="AI Chat">, launcher aria-expanded /
// aria-controls, aria-live="polite" message list, prefers-reduced-motion honored.

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useStore } from '@/store/useStore';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ChatQuickPrompts } from './ChatQuickPrompts';
import { useSpokenReplies } from './useSpokenReplies';

const PANEL_ID = 'ai-chat-panel';

function SpeakerIcon({ muted, className = '' }: { muted: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M11 5 6 9H2v6h4l5 4z" />
      {muted ? (
        <line x1="23" y1="9" x2="17" y2="15" />
      ) : (
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      )}
      {muted && <line x1="17" y1="9" x2="23" y2="15" />}
    </svg>
  );
}

// `showLauncher` controls the floating bottom-right launcher. Inside the shared
// AppShell the launcher lives in the top bar, so it is rendered with
// showLauncher={false}; the legacy /mission surface keeps the floating launcher.
export function ChatPanel({ showLauncher = true }: { showLauncher?: boolean } = {}) {
  const aiMessages = useStore((s) => s.aiMessages);
  const aiThinking = useStore((s) => s.aiThinking);
  const aiMode = useStore((s) => s.aiMode);
  const aiPanelOpen = useStore((s) => s.aiPanelOpen);
  const sendAIMessage = useStore((s) => s.sendAIMessage);
  const toggleAIPanel = useStore((s) => s.toggleAIPanel);
  const spoken = useSpokenReplies(aiMessages, aiPanelOpen);
  const reduceMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aiPanelOpen) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [aiMessages, aiThinking, aiPanelOpen, reduceMotion]);

  const submit = (text: string) => {
    if (!text.trim() || aiThinking) return;
    void sendAIMessage(text);
  };

  useEffect(() => {
    if (!aiPanelOpen) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') toggleAIPanel(); };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [aiPanelOpen, toggleAIPanel]);

  const offscreen = reduceMotion ? 0 : 360;

  return (
    <>
      {showLauncher && !aiPanelOpen && (
        <button
          type="button"
          onClick={toggleAIPanel}
          aria-expanded={aiPanelOpen}
          aria-controls={PANEL_ID}
          className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full border border-purple bg-purple/20 px-4 py-2.5 font-mono text-xs font-bold text-purple shadow-lg backdrop-blur transition-colors hover:bg-purple/30"
        >
          <span
            className="flex h-5 w-5 items-center justify-center rounded font-mono text-xs font-bold text-void"
            style={{ background: 'var(--purple)' }}
          >
            F
          </span>
          Ask Frank Coster
        </button>
      )}

      <AnimatePresence>
        {aiPanelOpen && (
          <motion.aside
            id={PANEL_ID}
            aria-label="AI Chat"
            initial={{ x: offscreen, opacity: reduceMotion ? 0 : 1 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: offscreen, opacity: reduceMotion ? 0 : 1 }}
            transition={{ duration: reduceMotion ? 0.15 : 0.25, ease: 'easeOut' }}
            className="fixed bottom-0 right-0 top-0 z-50 flex w-full max-w-[340px] flex-col border-l border-edge bg-deep font-body text-txt shadow-2xl"
          >
            <header className="flex items-center justify-between border-b border-edge px-4 py-3">
              <div className="flex items-center gap-2">
                <span
                  className="flex h-5 w-5 items-center justify-center rounded font-mono text-xs font-bold text-void"
                  style={{ background: 'var(--purple)' }}
                >
                  F
                </span>
                <span className="text-sm font-semibold text-txt">{FRANK.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
                  {aiMode}
                </span>
                {spoken.supported && (
                  <button
                    type="button"
                    onClick={spoken.toggle}
                    aria-pressed={spoken.enabled}
                    aria-label={spoken.enabled ? 'Disable spoken replies' : 'Enable spoken replies'}
                    title={
                      spoken.enabled
                        ? 'Spoken replies on — click to mute'
                        : 'Spoken replies off — click to hear answers read aloud'
                    }
                    className={`rounded border px-2 py-0.5 transition-colors ${
                      spoken.enabled
                        ? 'border-purple bg-purple/20 text-purple'
                        : 'border-edge text-sub hover:border-purple hover:text-txt'
                    }`}
                  >
                    <SpeakerIcon muted={!spoken.enabled} className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleAIPanel}
                  aria-expanded={aiPanelOpen}
                  aria-controls={PANEL_ID}
                  aria-label="Close AI chat"
                  className="rounded border border-edge px-2 py-0.5 font-mono text-xs text-sub transition-colors hover:border-purple hover:text-txt"
                >
                  ✕
                </button>
              </div>
            </header>

            <Link href="/agent-workflows" onClick={toggleAIPanel} className="border-b border-edge px-4 py-3 text-xs text-unit underline">Work through evidence and approvals with Frank</Link>
            <ChatQuickPrompts disabled={aiThinking} onSelect={submit} />

            <div
              ref={scrollRef}
              aria-live="polite"
              className="flex flex-1 flex-col gap-3 overflow-y-auto p-3"
            >
              {aiMessages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
              {aiThinking && (
                <div className="animate-pulse font-mono text-xs text-purple">Frank is reviewing…</div>
              )}
            </div>

            <ChatInput disabled={aiThinking} onSend={submit} />
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

