// Chat input — a growable textarea + send button (spec §7.3). Enter submits;
// Shift+Enter inserts a newline. Disabled while a turn is in flight. Owns only
// the draft string; the parent owns the conversation and the send action.
// Voice (Wave4): the mic appends a Web Speech transcript to this same draft —
// dictation is an input modality over the existing send path, nothing else
// changes. Browsers without SpeechRecognition get a muted glyph with an
// explanatory tooltip; the chat itself is unchanged.

import { useState, type KeyboardEvent } from 'react';
import { useVoiceDictation } from './useVoiceDictation';

interface ChatInputProps {
  disabled: boolean;
  onSend: (text: string) => void;
}

function MicIcon({ className = '' }: { className?: string }) {
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
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

export function ChatInput({ disabled, onSend }: ChatInputProps) {
  const [draft, setDraft] = useState('');
  // A committed transcript lands in the draft (appended, space-joined) so the
  // user can review or edit it — sending still flows through the existing path.
  const dictation = useVoiceDictation({
    onTranscript: (text) => setDraft((prev) => (prev ? `${prev} ${text}` : text)),
  });

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="border-t border-edge p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {(dictation.listening || dictation.error) && (
        <div className="pb-2">
          {dictation.listening && dictation.preview && (
            <p aria-live="polite" className="font-mono text-[10px] leading-relaxed text-purple">
              {dictation.preview}…
            </p>
          )}
          {dictation.error && (
            <p role="alert" className="font-mono text-[10px] leading-relaxed text-cost">
              {dictation.error}
            </p>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        {dictation.supported ? (
          <button
            type="button"
            onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
            aria-pressed={dictation.listening}
            aria-label={dictation.listening ? 'Stop voice input' : 'Start voice input'}
            title={dictation.listening ? 'Stop dictation' : 'Dictate your question'}
            className={`flex items-center rounded-md border px-3 py-2 font-mono text-xs transition-colors ${
              dictation.listening
                ? 'animate-pulse border-cost bg-cost/10 text-cost'
                : 'border-edge text-sub hover:border-purple hover:text-txt'
            }`}
          >
            <MicIcon className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span
            role="img"
            aria-label="Voice input is not available in this browser"
            title="Voice input isn't supported in this browser — type your question instead"
            className="flex cursor-help items-center rounded-md border border-edge px-3 py-2 text-dim opacity-40"
          >
            <MicIcon className="h-3.5 w-3.5" />
          </span>
        )}
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label="Ask about your initiative portfolio"
          placeholder="Ask about initiative risk, cost, or savings…"
          className="max-h-28 flex-1 resize-none rounded-md border border-edge bg-slab px-3 py-2 font-mono text-xs text-txt outline-none placeholder:text-dim focus:border-purple"
        />
        <button
          type="submit"
          disabled={disabled || !draft.trim()}
          className="rounded-md border border-purple bg-purple/20 px-3 py-2 font-mono text-xs font-bold text-purple transition-colors hover:bg-purple/30 disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </form>
  );
}
