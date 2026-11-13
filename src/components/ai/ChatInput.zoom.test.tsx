// @vitest-environment jsdom
// Owner report (iPhone): after typing in the Frank panel the page stayed zoomed in and
// the panel was cut off on the right. iOS Safari zooms into any focused text field
// whose font is smaller than 16px, so on small screens the textarea uses 16px
// (text-base) and only wider screens get the compact size (sm:text-xs).

import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChatInput } from './ChatInput';

afterEach(cleanup);

it('the chat textarea is 16px on phones so iOS Safari does not zoom in on focus', () => {
  render(<ChatInput onSend={() => {}} disabled={false} />);
  const box = screen.getByRole('textbox', { name: 'Ask about your initiative portfolio' });
  const classes = box.className.split(/\s+/);
  expect(classes).toContain('text-base');
  expect(classes).toContain('sm:text-xs');
  expect(classes).not.toContain('text-xs');
});
