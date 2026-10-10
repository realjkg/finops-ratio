// @vitest-environment jsdom
// ChatPanel spoken replies + panel-level voice degradation. The real store is
// driven with useStore.setState so the hooks run against the same zustand
// slice the app uses. jsdom has no Web Speech — fakes are stubbed explicitly,
// and the unstubbed render is the degradation case.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';
import { useStore, type AIChatMessage } from '@/store/useStore';

// jsdom implements no scrolling — ChatPanel's scroll-to-latest effect touches
// Element.scrollTo on every open panel.
beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});

interface FakeUtterance {
  text: string;
  lang: string;
  voice: unknown;
}

function makeSynth() {
  return {
    cancel: vi.fn(),
    speak: vi.fn(),
    getVoices: vi.fn(() => [{ lang: 'en-US', name: 'Test Voice' }]),
  };
}

function stubSpeech(synth: ReturnType<typeof makeSynth>): void {
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      text: string;
      lang = '';
      voice: unknown = null;
      constructor(text: string) {
        this.text = text;
      }
    },
  );
}

function msg(id: string, role: AIChatMessage['role'], content: string): AIChatMessage {
  return { id, role, content, timestamp: '2026-10-09T00:00:00.000Z' };
}

function openPanel(): void {
  useStore.setState({ aiPanelOpen: true });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  useStore.setState({ aiPanelOpen: false, aiMessages: [], aiThinking: false });
});

describe('ChatPanel — spoken replies (SpeechSynthesis supported)', () => {
  it('renders the toggle OFF by default and persists the choice per session', () => {
    const synth = makeSynth();
    stubSpeech(synth);
    openPanel();
    render(<ChatPanel showLauncher={false} />);

    const toggle = screen.getByRole('button', { name: 'Enable spoken replies' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false'); // spoken output OFF by default

    fireEvent.click(toggle);
    const active = screen.getByRole('button', { name: 'Disable spoken replies' });
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(window.sessionStorage.getItem('ratio.spoken-replies-v1')).toBe('1');

    fireEvent.click(active);
    expect(screen.getByRole('button', { name: 'Enable spoken replies' }).getAttribute('aria-pressed')).toBe('false');
    expect(window.sessionStorage.getItem('ratio.spoken-replies-v1')).toBe('0');
  });

  it('speaks a NEW assistant reply (markdown stripped), never the loaded history', async () => {
    const synth = makeSynth();
    stubSpeech(synth);
    openPanel();
    useStore.setState({
      aiMessages: [msg('m1', 'user', 'how are we doing'), msg('m2', 'assistant', 'Workload **Atlas** is above budget.')],
    });
    render(<ChatPanel showLauncher={false} />);

    await act(async () => {}); // settle effects
    expect(synth.speak).not.toHaveBeenCalled(); // loaded history is never read aloud

    fireEvent.click(screen.getByRole('button', { name: 'Enable spoken replies' }));
    const before = useStore.getState().aiMessages;
    act(() => {
      useStore.setState({
        aiMessages: [...before, msg('m3', 'assistant', 'Try `governance gates` first.')],
      });
    });

    await waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(1));
    const utterance = synth.speak.mock.calls[0][0] as FakeUtterance;
    expect(utterance.text).toBe('Try governance gates first.'); // markdown stripped
    expect(utterance.lang).toBe(navigator.language); // browser locale, not hardcoded
  });

  it('does not speak while muted and cancels pending speech on mute', async () => {
    const synth = makeSynth();
    stubSpeech(synth);
    openPanel();
    render(<ChatPanel showLauncher={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable spoken replies' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable spoken replies' }));
    const before = useStore.getState().aiMessages;
    act(() => {
      useStore.setState({ aiMessages: [...before, msg('m4', 'assistant', 'another answer')] });
    });

    await act(async () => {});
    expect(synth.speak).not.toHaveBeenCalled(); // muted — nothing read
    expect(synth.cancel).toHaveBeenCalled(); // pending speech stopped on mute
  });
});

describe('ChatPanel — graceful degradation', () => {
  it('omits the spoken-replies toggle and the mic when the APIs are missing', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    openPanel();
    render(<ChatPanel showLauncher={false} />);

    expect(screen.queryByRole('button', { name: 'Enable spoken replies' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start voice input' })).toBeNull(); // no mic button
    expect(screen.getByLabelText('Voice input is not available in this browser')).toBeTruthy();
    // The chat itself is fully functional:
    expect(screen.getByLabelText('Ask about your initiative portfolio')).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
