// useSpokenReplies — optional spoken agent replies via SpeechSynthesis.
// OFF by default; the toggle persists per session (sessionStorage). Speaks a
// NEW assistant reply once (never the loaded history) while the panel is
// active, and cancels pending speech when muted, when the panel closes, or on
// unmount.

import { useEffect, useRef, useState } from 'react';
import type { AIChatMessage } from '@/store/useStore';
import { cancelSpeaking, loadSpokenRepliesPref, saveSpokenRepliesPref, speak, speechSynthesisSupported, stripMarkdownForSpeech } from './voice';

export interface SpokenReplies {
  supported: boolean;
  enabled: boolean;
  toggle: () => void;
}

export function useSpokenReplies(messages: AIChatMessage[], active: boolean): SpokenReplies {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [enabled, setEnabled] = useState(false); // spoken output OFF by default
  const supported = mounted && speechSynthesisSupported();

  // Hydrate the per-session preference after mount (sessionStorage is browser-only).
  useEffect(() => {
    const saved = loadSpokenRepliesPref();
    if (saved !== null) setEnabled(saved);
  }, []);

  // Persist on every change (per session only — never localStorage).
  useEffect(() => {
    if (!mounted) return;
    saveSpokenRepliesPref(enabled);
  }, [enabled, mounted]);

  const lastSeenIdRef = useRef<string | null>(null);
  useEffect(() => {
    const latest = lastAssistantMessage(messages);
    if (!latest) return;
    if (lastSeenIdRef.current === latest.id) return;
    // First sight after mount is the loaded history — never read it aloud.
    const isNewReply = lastSeenIdRef.current !== null;
    lastSeenIdRef.current = latest.id;
    if (!isNewReply || !enabled || !active) return;
    speak(stripMarkdownForSpeech(latest.content));
  }, [messages, enabled, active]);

  // Muted or panel closed — stop any speech immediately; also on unmount.
  useEffect(() => {
    if (!active || !enabled) cancelSpeaking();
  }, [active, enabled]);
  useEffect(() => () => cancelSpeaking(), []);

  const toggle = () => setEnabled((prev) => !prev);
  return { supported, enabled, toggle };
}

/** Latest assistant reply, or null when the thread ends with user/system messages. */
export function lastAssistantMessage(messages: AIChatMessage[]): AIChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i];
  }
  return null;
}
