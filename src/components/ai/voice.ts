// Web Speech API support for the agent chat (Wave4 voice). Browser-native —
// no backend, no keys, no new runtime dependency. SpeechRecognition types are
// absent from the TS DOM lib, so this module carries a minimal local stub and
// keeps every browser access behind a guarded lookup. Pure helpers and the
// dictation controller are testable without a DOM (inject the recognition).

// ---- Minimal Web Speech types (DOM lib has SpeechSynthesis, not SpeechRecognition) ----

export interface SpeechAlternativeLike {
  transcript: string;
}

export interface SpeechResultLike extends ArrayLike<SpeechAlternativeLike> {
  isFinal: boolean;
}

export type SpeechResultsLike = ArrayLike<SpeechResultLike>;

export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechResultsLike;
}

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort?(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => RecognitionLike;
export type RecognitionFactory = () => RecognitionLike | null;

// ---- Feature guards (never throw, never log — absence is a supported state) ----

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  // Browsers expose the ctor on window (=== globalThis); reading globalThis also
  // lets tests stub it with vi.stubGlobal (jsdom's window is not globalThis).
  const g = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

function defaultRecognitionFactory(): RecognitionLike | null {
  const ctor = getSpeechRecognitionCtor();
  return ctor ? new ctor() : null;
}

export function speechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in globalThis;
}

// ---- Locale ----

/**
 * The recognition language follows the browser locale — never a hardcoded
 * default, so dictation works on any localized chat. When the app gains i18n,
 * pass the app locale as `explicit` and the same call site keeps working.
 * `undefined` (no locale info) lets the browser pick its own default.
 */
export function recognitionLanguage(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
  return undefined;
}

// ---- Inline error copy (one-line hints — no stack traces in the chat) ----

export const MIC_PERMISSION_DENIED =
  'Microphone access was denied — allow the mic permission for this site and try again.';
export const VOICE_INPUT_FAILED = 'Voice input did not work — try again.';

// ---- Dictation controller ----

export interface DictationCallbacks {
  /** Live transcript while recording (finals + interim). */
  onPreview: (text: string) => void;
  /** Final transcript — lands in the existing chat input draft. */
  onCommit: (text: string) => void;
  /** One-line inline hint (permission denial, generic failure). */
  onError: (message: string) => void;
  /** Recognition ended (silence, stop click, or error) — recording is over. */
  onEnd: () => void;
}

/**
 * Drives one dictation session over a SpeechRecognition instance. Single-
 * utterance mode (continuous=false): the browser stops on silence, so "stop
 * on silence" is native behavior and a second click on the mic calls stop().
 */
export class VoiceDictationController {
  private recognition: RecognitionLike | null = null;
  private finals: string[] = [];
  private interim = '';

  constructor(
    private readonly callbacks: DictationCallbacks,
    private readonly createRecognition: RecognitionFactory = defaultRecognitionFactory,
    private readonly getLang: () => string | undefined = () => recognitionLanguage(),
  ) {}

  /** Starts recognition. Returns false when the API is unavailable or start fails. */
  start(): boolean {
    if (this.recognition) return true;
    const recognition = this.createRecognition();
    if (!recognition) return false;

    const lang = this.getLang();
    if (lang) recognition.lang = lang;
    recognition.continuous = false; // browser stops on silence
    recognition.interimResults = true; // live preview
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event.error);
    recognition.onend = () => this.handleEnd();

    try {
      recognition.start();
    } catch {
      // start() throws on a racing session (e.g. double-invoke) — surface it,
      // never a console stack trace.
      this.reset();
      this.callbacks.onError(VOICE_INPUT_FAILED);
      return false;
    }

    this.recognition = recognition;
    return true;
  }

  stop(): void {
    this.recognition?.stop();
  }

  /** Teardown on unmount — detach handlers and abort any live session. */
  dispose(): void {
    const recognition = this.recognition;
    this.reset();
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort?.();
    } catch {
      // Teardown is best-effort; nothing actionable if abort refuses.
    }
  }

  private handleResult(event: SpeechRecognitionEventLike): void {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0]?.transcript ?? '';
      if (result.isFinal) {
        this.finals.push(transcript.trim());
        this.interim = ''; // a final result supersedes any interim tail
      } else {
        this.interim = transcript;
      }
    }
    this.callbacks.onPreview(this.previewText());
  }

  private previewText(): string {
    const finalText = this.finals.join(' ').trim();
    if (!finalText) return this.interim.trim();
    return this.interim ? `${finalText} ${this.interim.trim()}` : finalText;
  }

  private handleEnd(): void {
    const finalText = this.finals.join(' ').trim();
    const text = finalText || this.interim.trim();
    this.reset();
    if (text) this.callbacks.onCommit(text);
    this.callbacks.onEnd();
  }

  private handleError(code: string): void {
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      this.callbacks.onError(MIC_PERMISSION_DENIED);
      return;
    }
    // no-speech / aborted end quietly via onend; anything else is a generic retry hint.
    if (code !== 'no-speech' && code !== 'aborted') this.callbacks.onError(VOICE_INPUT_FAILED);
  }

  private reset(): void {
    this.recognition = null;
    this.finals = [];
    this.interim = '';
  }
}

// ---- Spoken replies (SpeechSynthesis) ----

/**
 * Strips markdown so a reply is read as prose: code fences, links, emphasis,
 * headings and list markers out; words kept.
 */
export function stripMarkdownForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code → its text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → link text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // bullets
    .replace(/^\s{0,3}\d+\.\s+/gm, '') // ordered lists
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/\|/g, ' ') // table pipes
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Picks the best installed voice for a language: exact locale match first
 * (de-DE), then any dialect of the base language (de-*), else null — the
 * browser default voice speaks.
 */
export function pickVoice<T extends { lang: string }>(voices: ArrayLike<T>, lang: string | undefined): T | null {
  if (!lang || voices.length === 0) return null;
  const lower = lang.toLowerCase();
  for (let i = 0; i < voices.length; i++) {
    if (voices[i].lang.toLowerCase() === lower) return voices[i];
  }
  const base = lower.split('-')[0];
  for (let i = 0; i < voices.length; i++) {
    if (voices[i].lang.toLowerCase().startsWith(base)) return voices[i];
  }
  return null;
}

export function cancelSpeaking(): void {
  if (!speechSynthesisSupported()) return;
  globalThis.speechSynthesis.cancel();
}

/** Speaks one reply with the browser's installed voices; follows the browser locale. */
export function speak(text: string, getLang: () => string | undefined = () => recognitionLanguage()): void {
  const trimmed = text.trim();
  if (!trimmed || !speechSynthesisSupported()) return;
  const utterance = new SpeechSynthesisUtterance(trimmed);
  const lang = getLang();
  if (lang) utterance.lang = lang;
  const synth = globalThis.speechSynthesis;
  const voice = pickVoice(synth.getVoices(), lang);
  if (voice) utterance.voice = voice;
  synth.cancel(); // a new answer supersedes the one being read
  synth.speak(utterance);
}

// ---- Per-session spoken-replies preference (sessionStorage) ----

const SPOKEN_PREF_KEY = 'ratio.spoken-replies-v1';

/** Returns the persisted pref, or null when unset (and default is OFF). */
export function loadSpokenRepliesPref(): boolean | null {
  if (typeof window === 'undefined' || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(SPOKEN_PREF_KEY);
    return raw === '1' ? true : raw === '0' ? false : null;
  } catch {
    // e.g. Safari private mode blocks storage — the pref just doesn't persist;
    // speaking still works. Nothing actionable.
    return null;
  }
}

export function saveSpokenRepliesPref(enabled: boolean): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(SPOKEN_PREF_KEY, enabled ? '1' : '0');
  } catch {
    // See loadSpokenRepliesPref — non-persistence is the graceful path.
  }
}
