// Small talk: purely conversational turns get a deterministic, friendly reply
// that points at real questions, instead of "I can't answer that from this data".
// Anything that carries a question goes to the analytic router unchanged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASIS, UNSUPPORTED, ask, last, nextQuestions, restoreClock, useFastClock } from './__testkit__/ask';
import { smallTalkKinds } from './smalltalk';

beforeAll(useFastClock);
afterAll(restoreClock);

describe('recognizing purely conversational turns', () => {
  it.each([
    ['Hi Frank', ['greeting']],
    ['Good morning!', ['greeting']],
    ['hello there', ['greeting']],
    ['Hey Frank 👋', ['greeting']],
    ['thanks Frank', ['thanks']],
    ['Thank you so much!', ['thanks']],
    ['who are you?', ['identity']],
    ['Are you an AI?', ['identity']],
    ['how are you doing today?', ['how_are_you']],
    ['Hi Frank, how are you?', ['greeting', 'how_are_you']],
    ['ok', ['acknowledge']],
    ['sounds good', ['acknowledge']],
    ['bye', ['farewell']],
    ['where do I start?', ['start']],
    ['What should I ask you?', ['start']],
  ])('%s', (q, kinds) => {
    expect(smallTalkKinds(q)).toEqual(kinds);
  });

  it.each([
    'Hi Frank, which team is driving the highest cost?',
    'thanks, what about Legal?',
    'okay show the workloads',
    'What is the ROI of the portfolio?',
    'help',
    'hi, how much can we save?',
    '',
  ])('not small talk: %s', (q) => {
    expect(smallTalkKinds(q)).toBeNull();
  });
});

describe('small-talk replies', () => {
  it('"Hi Frank" gets a greeting that mirrors the user and suggests answerable questions', async () => {
    const t = await last(['Hi Frank']);
    expect(t.split('\n')[0]).toBe("**Hi — I'm Frank Coster**");
    expect(t).not.toContain(UNSUPPORTED);
    expect(t).toMatch(BASIS);
    const next = nextQuestions(t);
    expect(next.length).toBeGreaterThanOrEqual(3);
    for (const q of next) expect(await last([q]), q).not.toContain(UNSUPPORTED);
  });

  it('mirrors the greeting it was given', async () => {
    expect((await last(['Good morning, Frank'])).split('\n')[0]).toBe("**Good morning — I'm Frank Coster**");
    expect((await last(['hello'])).split('\n')[0]).toBe("**Hello — I'm Frank Coster**");
    expect((await last(['Hey there!'])).split('\n')[0]).toBe("**Hey — I'm Frank Coster**");
  });

  it('greeting plus "how are you" answers both', async () => {
    const t = await last(['Hi Frank, how are you?']);
    expect(t.split('\n')[0]).toBe("**Hi — I'm Frank Coster**");
    expect(t).toMatch(/same answer to the same question/);
  });

  it('identity is honest: deterministic, not a generative model', async () => {
    const t = await last(['Who are you?']);
    expect(t).toMatch(/deterministic/);
    expect(t).toMatch(/not a generative AI model/);
    expect(t).not.toContain(UNSUPPORTED);
  });

  it('"ok" no longer produces an unrelated team table', async () => {
    const t = await last(['ok']);
    expect(t).not.toMatch(/Teams ranked by/);
    expect(t).not.toContain(UNSUPPORTED);
  });

  it('thanks after a team answer suggests next steps for that team', async () => {
    const r = await ask(['Which team is driving the highest cost?', 'thanks']);
    const team = /\*\*Highest-cost team: (.+)\*\*/.exec(r[0])?.[1];
    expect(team).toBeTruthy();
    expect(r[1].split('\n')[0]).toBe("**You're welcome**");
    expect(nextQuestions(r[1]).some((q) => q.includes(team as string))).toBe(true);
  });

  it('small talk does not erase the conversation subject', async () => {
    const r = await ask(['What is the ROI of the CX Engineering team?', 'thanks', 'what about its workloads?']);
    expect(r[2]).toContain('CX Engineering');
    expect(r[2]).not.toContain(UNSUPPORTED);
  });

  it('"where do I start?" gives the full capability answer', async () => {
    expect(await last(['where do I start?'])).toBe(await last(['What can you answer?']));
  });

  it('goodbye is polite and asks nothing', async () => {
    const t = await last(['bye']);
    expect(t.split('\n')[0]).toBe('**Goodbye**');
    expect(t).not.toContain(UNSUPPORTED);
  });

  it('every small-talk reply carries the source line and is deterministic', async () => {
    for (const q of ['Hi Frank', 'thanks', 'ok', 'bye', 'who are you?', 'how are you?']) {
      const a = await last([q]);
      expect(a, q).toMatch(BASIS);
      expect(await last([q]), q).toBe(a);
    }
  });

  it('a greeting in front of a real question still gets the real answer', async () => {
    expect(await last(['Hi Frank, which team is driving the highest cost?'])).toBe(await last(['Which team is driving the highest cost?']));
  });
});
