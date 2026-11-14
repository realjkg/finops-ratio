// @vitest-environment jsdom
// A question over the mode's limit is refused by the panel; the draft is kept so it can be
// shortened, and a counter shows the length instead of a paste being cut silently.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from './ChatInput';

afterEach(cleanup);
const box = () => screen.getByLabelText('Ask about your initiative portfolio') as HTMLTextAreaElement;

describe('ChatInput length limit', () => {
  it('a long paste is not cut; the counter shows the length; a refused draft is kept', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} maxChars={2000} />);
    fireEvent.change(box(), { target: { value: 'x'.repeat(2500) } });
    expect(box().value).toHaveLength(2500);
    expect(screen.getByTestId('chat-char-count').textContent).toBe('2,500 / 2,000 characters');
    fireEvent.submit(box().closest('form')!);
    expect(onSend).toHaveBeenCalledWith('x'.repeat(2500));
    expect(box().value).toHaveLength(2500);
  });
  it('a question within the limit is sent and cleared; no counter far from the limit', () => {
    const onSend = vi.fn();
    render(<ChatInput disabled={false} onSend={onSend} />);
    fireEvent.change(box(), { target: { value: 'Which initiatives are at risk?' } });
    expect(screen.queryByTestId('chat-char-count')).toBeNull();
    fireEvent.submit(box().closest('form')!);
    expect(onSend).toHaveBeenCalledWith('Which initiatives are at risk?');
    expect(box().value).toBe('');
  });
});
