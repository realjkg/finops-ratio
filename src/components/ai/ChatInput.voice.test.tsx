// @vitest-environment jsdom
// ChatInput dictation flow in jsdom. jsdom ships no Web Speech API — exactly
// the degradation case — so the tests stub a FakeRecognition global for the
// supported path and rely on its absence for the degradation path.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from './ChatInput';
import { MIC_PERMISSION_DENIED, type RecognitionLike, type SpeechRecognitionEventLike } from './voice';

class FakeRecognition implements RecognitionLike {
  static latest: FakeRecognition | null = null;

  lang = '';
  continuous = false;
  interimResults = false;
  started = false;
  stopCalls = 0;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.latest = this;
  }

  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopCalls += 1;
  }

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

const TEXTAREA_LABEL = 'Ask about your initiative portfolio';

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText(TEXTAREA_LABEL) as HTMLTextAreaElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

describe('ChatInput — voice dictation (Web Speech supported)', () => {
  it('dictates a transcript into the input and sends through the existing path', () => {
    const onSend = vi.fn();
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    render(<ChatInput disabled={false} onSend={onSend} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    const rec = FakeRecognition.latest;
    expect(rec).not.toBeNull();
    expect(rec?.started).toBe(true);
    expect(rec?.lang).toBe(navigator.language); // follows the browser locale — no hardcoded default
    expect(rec?.continuous).toBe(false); // stop on silence is native
    expect(rec?.interimResults).toBe(true); // live preview

    act(() => rec?.say('was', false)); // interim → live preview
    expect(screen.getByText('was…')).toBeTruthy();
    act(() => rec?.say('what is our spend', true)); // final supersedes the interim
    expect(screen.getByText('what is our spend…')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop voice input' }));
    expect(rec?.stopCalls).toBe(1);
    act(() => rec?.end()); // the browser fires onend after stop()

    expect(textarea().value).toBe('what is our spend'); // transcript landed in the existing input
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('what is our spend'); // unchanged send path
    expect(textarea().value).toBe('');
  });

  it('commits on silence (onend) without a stop click', () => {
    const onSend = vi.fn();
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    render(<ChatInput disabled={false} onSend={onSend} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    const rec = FakeRecognition.latest;
    act(() => rec?.say('hello there', false));
    act(() => rec?.end()); // silence — the browser ended the session

    expect(textarea().value).toBe('hello there');
    expect(screen.queryByText(/…$/)).toBeNull(); // preview cleared after commit
    expect(screen.getByRole('button', { name: 'Start voice input' })).toBeTruthy(); // mic reset
  });

  it('appends a second dictation to the draft instead of replacing it', () => {
    const onSend = vi.fn();
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    render(<ChatInput disabled={false} onSend={onSend} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    const rec = FakeRecognition.latest;
    act(() => {
      rec?.say('compare staging and prod', true);
      rec?.end();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    const rec2 = FakeRecognition.latest;
    act(() => {
      rec2?.say('spend', true);
      rec2?.end();
    });

    expect(textarea().value).toBe('compare staging and prod spend');
  });

  it('shows the inline permission hint on mic denial — no console errors', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('SpeechRecognition', FakeRecognition);
    render(<ChatInput disabled={false} onSend={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
    const rec = FakeRecognition.latest;
    act(() => rec?.fail('not-allowed'));

    expect(screen.getByRole('alert').textContent).toBe(MIC_PERMISSION_DENIED);
    act(() => rec?.end());
    expect(textarea().value).toBe(''); // nothing committed
    expect(consoleError).not.toHaveBeenCalled(); // no stack traces in the chat
    consoleError.mockRestore();
  });
});

describe('ChatInput — graceful degradation (no SpeechRecognition)', () => {
  it('hides the mic behind an explanatory tooltip and keeps the chat functional', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // jsdom has no Web Speech — nothing to stub: this is the Firefox path.
    render(<ChatInput disabled={false} onSend={() => {}} />);

    expect(screen.queryByRole('button', { name: 'Start voice input' })).toBeNull(); // no mic button
    const hint = screen.getByLabelText('Voice input is not available in this browser');
    expect(hint.getAttribute('title')).toContain('type your question instead'); // explanatory tooltip

    // Chat fully functional: type + send still work.
    fireEvent.change(textarea(), { target: { value: 'typed instead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(textarea().value).toBe('');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
