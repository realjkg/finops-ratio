// @vitest-environment jsdom
// A question over the mode's limit cannot be sent; the draft is kept so it can be shortened, and a
// counter (referenced by the textarea, announced on crossing) shows the length of what would be
// sent, instead of a paste being cut silently.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from './ChatInput';
import { ChatPanel } from './ChatPanel';
import { useStore } from '@/store/useStore';

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
});
afterEach(cleanup);
const box = () => screen.getByLabelText('Ask about your initiative portfolio') as HTMLTextAreaElement;
const send = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
const count = () => screen.getByTestId('chat-char-count');

describe('ChatInput length limit', () => {
  it('over the limit: nothing is cut, Send is disabled, the draft stays, the counter says so', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} maxChars={2000} />);
    fireEvent.change(box(), { target: { value: 'x'.repeat(2500) } });
    expect(box().value).toHaveLength(2500);
    expect(count().textContent).toBe('2,500 / 2,000 characters (over the limit)');
    expect(box().getAttribute('aria-describedby')).toBe(count().id);
    expect(send().disabled).toBe(true);
    fireEvent.submit(box().closest('form')!);
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toHaveLength(2500);
    expect(screen.getByText('Over the 2,000-character limit. Shorten the question to send it.')).toBeTruthy();
  });
  it('near the limit: the counter shows; trailing whitespace is not counted', () => {
    render(<ChatInput disabled={false} onSend={() => {}} maxChars={2000} />);
    fireEvent.change(box(), { target: { value: 'x'.repeat(1900) } });
    expect(count().textContent).toBe('1,900 / 2,000 characters');
    fireEvent.change(box(), { target: { value: `${'x'.repeat(2000)}\n` } });
    expect(count().textContent).toBe('2,000 / 2,000 characters');
    expect(send().disabled).toBe(false);
  });
  it('within the limit: sent and cleared; the counter is present but empty far from the limit', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: 'Which initiatives are at risk?' } });
    expect(count().textContent).toBe('');
    fireEvent.submit(box().closest('form')!);
    expect(onSend).toHaveBeenCalledWith('Which initiatives are at risk?');
    expect(box().value).toBe('');
  });
  it('the panel passes the simulation limit in simulation mode', () => {
    useStore.setState({ aiPanelOpen: true, aiMessages: [], aiThinking: false, simulation: { session: { csrf: 'c' }, state: {} } as never });
    render(<ChatPanel />);
    fireEvent.change(box(), { target: { value: 'x'.repeat(2500) } });
    expect(send().disabled).toBe(true);
    expect(count().textContent).toBe('2,500 / 2,000 characters (over the limit)');
    useStore.setState({ simulation: null, aiPanelOpen: false });
  });
});
