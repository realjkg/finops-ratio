// Voice helpers under plain node — no DOM, no Web Speech. The dictation
// controller takes an injected recognition factory + locale provider, so the
// recognition event flow (interim preview → final commit, permission denial,
// stop-on-silence) is testable without a browser. Storage helpers degrade to
// null/no-op when window is absent (node).

import { describe, expect, it } from 'vitest';
import {
  MIC_PERMISSION_DENIED,
  VOICE_INPUT_FAILED,
  VoiceDictationController,
  cancelSpeaking,
  loadSpokenRepliesPref,
  pickVoice,
  recognitionLanguage,
  saveSpokenRepliesPref,
  speak,
  stripMarkdownForSpeech,
  type RecognitionLike,
  type SpeechRecognitionEventLike,
} from './voice';
import { lastAssistantMessage } from './useSpokenReplies';
import type { AIChatMessage } from '@/store/useStore';

class FakeRecognition implements RecognitionLike {
  lang = '';
  continuous = false;
  interimResults = false;
  started = false;
  stopCalls = 0;
  abortCalls = 0;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopCalls += 1;
  }
  abort(): void {
    this.abortCalls += 1;
  }

  /** Emits one recognition result (interim or final) as the browser would. */
  say(transcript: string, isFinal: boolean): void {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal, 0: { transcript }, length: 1 }],
    });
  }

  end(): void {
    this.onend?.();
  }

  fail(code: string): void {
    this.onerror?.({ error: code });
  }
}

interface Captured {
  previews: string[];
  commits: string[];
  errors: string[];
  ends: number;
}

function makeController(recognition: FakeRecognition | null, getLang: () => string | undefined = () => undefined) {
  const captured: Captured = { previews: [], commits: [], errors: [], ends: 0 };
  const controller = new VoiceDictationController(
    {
      onPreview: (text) => captured.previews.push(text),
      onCommit: (text) => captured.commits.push(text),
      onError: (message) => captured.errors.push(message),
      onEnd: () => {
        captured.ends += 1;
      },
    },
    () => recognition,
    getLang,
  );
  return { controller, captured };
}

describe('recognitionLanguage', () => {
  it('prefers the explicit locale (the future i18n hook point)', () => {
    expect(recognitionLanguage('fr-FR')).toBe('fr-FR');
  });

  it('falls back to the navigator locale, never a hardcoded default', () => {
    // node 20 has no navigator — the helper hands the choice to the browser.
    expect(recognitionLanguage()).toBeUndefined();
  });
});

describe('VoiceDictationController', () => {
  it('configures recognition for stop-on-silence dictation with a live preview', () => {
    const rec = new FakeRecognition();
    const { controller } = makeController(rec, () => 'pt-BR');

    expect(controller.start()).toBe(true);
    expect(rec.started).toBe(true);
    expect(rec.lang).toBe('pt-BR'); // recognition.lang follows the locale
    expect(rec.continuous).toBe(false); // browser stops on silence
    expect(rec.interimResults).toBe(true); // live transcript preview
  });

  it('previews interim results without committing', () => {
    const rec = new FakeRecognition();
    const { controller, captured } = makeController(rec);
    controller.start();

    rec.say('qu', false);
    rec.say('qual o custo', false);
    expect(captured.previews).toEqual(['qu', 'qual o custo']);
    expect(captured.commits).toEqual([]);
  });

  it('commits the final transcript on end (silence or stop click)', () => {
    const rec = new FakeRecognition();
    const { controller, captured } = makeController(rec);
    controller.start();

    rec.say('what is our spend', true);
    rec.end();
    expect(captured.commits).toEqual(['what is our spend']);
    expect(captured.ends).toBe(1);
  });

  it('commits the interim tail when recognition ends without a final', () => {
    const rec = new FakeRecognition();
    const { controller, captured } = makeController(rec);
    controller.start();

    rec.say('hello there', false);
    rec.end();
    expect(captured.commits).toEqual(['hello there']);
  });

  it('lets a final result supersede the interim tail', () => {
    const rec = new FakeRecognition();
    const { controller, captured } = makeController(rec);
    controller.start();

    rec.say('was', false);
    rec.say('what is our spend', true);
    expect(captured.previews[captured.previews.length - 1]).toBe('what is our spend');
    rec.end();
    expect(captured.commits).toEqual(['what is our spend']);
  });

  it('maps permission denial to the inline hint and never commits', () => {
    const rec = new FakeRecognition();
    const { controller, captured } = makeController(rec);
    controller.start();

    rec.fail('not-allowed');
    expect(captured.errors).toEqual([MIC_PERMISSION_DENIED]);
    rec.end();
    expect(captured.commits).toEqual([]);
    expect(captured.ends).toBe(1); // recording is over — mic button resets
  });

  it('stays quiet on no-speech (nothing dictated is not an error)', () => {
    const rec = new FakeRecognition();
    const { controller, captured } = makeController(rec);
    controller.start();

    rec.fail('no-speech');
    rec.end();
    expect(captured.errors).toEqual([]);
    expect(captured.ends).toBe(1);
  });

  it('maps unexpected failures to the generic one-line hint', () => {
    const rec = new FakeRecognition();
    const { controller, captured } = makeController(rec);
    controller.start();

    rec.fail('network');
    expect(captured.errors).toEqual([VOICE_INPUT_FAILED]);
  });

  it('stop() asks the recognition to stop (click-to-stop)', () => {
    const rec = new FakeRecognition();
    const { controller } = makeController(rec);
    controller.start();

    controller.stop();
    expect(rec.stopCalls).toBe(1);
  });

  it('reports unsupported when the browser has no SpeechRecognition', () => {
    const { controller, captured } = makeController(null);
    expect(controller.start()).toBe(false);
    expect(captured.errors).toEqual([]);
    expect(captured.ends).toBe(0);
  });

  it('dispose aborts the session and detaches handlers', () => {
    const rec = new FakeRecognition();
    const { controller, captured } = makeController(rec);
    controller.start();

    controller.dispose();
    expect(rec.abortCalls).toBe(1);
    expect(rec.onend).toBeNull();
    rec.end(); // late browser event after dispose — nothing observed
    expect(captured.commits).toEqual([]);
    expect(captured.ends).toBe(0);
  });
});

describe('stripMarkdownForSpeech', () => {
  it('reads structure as prose: headings, bullets, emphasis', () => {
    expect(stripMarkdownForSpeech('## Findings\n- item **one**\n- item *two*')).toBe(
      'Findings item one item two',
    );
  });

  it('drops code blocks and reads links as their text', () => {
    expect(stripMarkdownForSpeech('before\n```js\ncode()\n```\nsee [docs](https://x.y) now')).toBe(
      'before see docs now',
    );
  });

  it('keeps plain sentences intact', () => {
    expect(stripMarkdownForSpeech('Workload A is above budget.')).toBe(
      'Workload A is above budget.',
    );
  });
});

describe('pickVoice', () => {
  const voices = [{ lang: 'en-US' }, { lang: 'de-DE' }, { lang: 'de-AT' }];

  it('prefers an exact locale match', () => {
    expect(pickVoice(voices, 'de-AT')?.lang).toBe('de-AT');
  });

  it('falls back to any dialect of the base language', () => {
    expect(pickVoice(voices, 'de-CH')?.lang).toBe('de-DE');
  });

  it('returns null so the browser default speaks when nothing matches', () => {
    expect(pickVoice(voices, 'ja-JP')).toBeNull();
    expect(pickVoice(voices, undefined)).toBeNull();
    expect(pickVoice([], 'en-US')).toBeNull();
  });
});

describe('lastAssistantMessage', () => {
  const msg = (id: string, role: AIChatMessage['role']): AIChatMessage => ({
    id,
    role,
    content: `content ${id}`,
    timestamp: '2026-10-09T00:00:00.000Z',
  });

  it('finds the latest assistant reply among trailing user/system messages', () => {
    const found = lastAssistantMessage([
      msg('1', 'user'),
      msg('2', 'assistant'),
      msg('3', 'user'),
      msg('4', 'system'),
    ]);
    expect(found?.id).toBe('2');
  });

  it('returns null when there is no assistant reply', () => {
    expect(lastAssistantMessage([msg('1', 'user'), msg('2', 'system')])).toBeNull();
    expect(lastAssistantMessage([])).toBeNull();
  });
});

describe('speech + storage guards outside the browser', () => {
  it('speak/cancel and the session pref degrade without window', () => {
    expect(() => {
      speak('hello');
      cancelSpeaking();
      saveSpokenRepliesPref(true);
    }).not.toThrow();
    expect(loadSpokenRepliesPref()).toBeNull();
  });

  it('speak ignores empty text', () => {
    expect(() => speak('   ')).not.toThrow();
  });
});
