// useVoiceDictation — React binding over VoiceDictationController. Owns the
// listening/preview/error state; the transcript is handed to `onTranscript`,
// which the ChatInput routes into the existing draft → send path. Revealed
// only after mount so SSR and first client render agree (no hydration flash).

import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceDictationController, getSpeechRecognitionCtor } from './voice';

interface VoiceDictationOptions {
  onTranscript: (text: string) => void;
}

export interface VoiceDictation {
  supported: boolean;
  listening: boolean;
  preview: string;
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useVoiceDictation({ onTranscript }: VoiceDictationOptions): VoiceDictation {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const [listening, setListening] = useState(false);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Latest-callback ref keeps the controller instance stable across renders.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const controllerRef = useRef<VoiceDictationController | null>(null);
  const getController = useCallback(() => {
    controllerRef.current ??= new VoiceDictationController({
      onPreview: setPreview,
      onCommit: (text) => onTranscriptRef.current(text),
      onError: setError,
      onEnd: () => {
        setListening(false);
        setPreview('');
      },
    });
    return controllerRef.current;
  }, []);

  const supported = mounted && typeof window !== 'undefined' && getSpeechRecognitionCtor() !== null;

  const start = useCallback(() => {
    if (!supported) return;
    setError(null);
    if (getController().start()) setListening(true);
  }, [supported, getController]);

  const stop = useCallback(() => {
    controllerRef.current?.stop();
  }, []);

  // Unmount mid-dictation (panel closed) — abort the session, keep no handlers.
  useEffect(
    () => () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    },
    [],
  );

  return { supported, listening, preview, error, start, stop };
}
