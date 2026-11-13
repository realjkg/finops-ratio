// @vitest-environment jsdom
// Assistant replies render as readable prose for executives: a heading, real
// lists and a source footnote in the body font, never as raw "**" monospace
// text, and never by interpreting reply text as HTML.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChatMessage } from './ChatMessage';
import type { AIChatMessage } from '@/store/useStore';

afterEach(cleanup);

const reply = (content: string): AIChatMessage => ({ id: 'm1', role: 'assistant', content }) as AIChatMessage;

describe('ChatMessage (assistant)', () => {
  it('shows the heading without asterisks, sections as lists, and the source line', () => {
    const { container } = render(
      <ChatMessage
        message={reply("**I'm Frank Coster**\nWhat I do:\n• Show cost\n• Rank teams\nSource: demo dataset as of 2026-06-25.")}
      />,
    );
    expect(screen.getByText("I'm Frank Coster")).toBeTruthy();
    expect(container.textContent).not.toContain('**');
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Show cost', 'Rank teams']);
    expect(screen.getByText(/^Source: demo dataset/)).toBeTruthy();
    expect(container.querySelector('.font-mono')).toBeNull();
  });

  it('never interprets reply text as HTML', () => {
    const { container } = render(<ChatMessage message={reply('**<img src=x onerror=alert(1)>**\n• <script>x</script>')} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
