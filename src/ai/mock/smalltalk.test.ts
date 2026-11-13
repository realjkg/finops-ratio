// Small talk: purely conversational turns get a deterministic, friendly reply
// that points at real questions, instead of "I can't answer that from this data".
// Anything that carries a question goes to the analytic router unchanged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASIS, CTX, UNSUPPORTED, ask, last, nextQuestions, restoreClock, useFastClock } from './__testkit__/ask';
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
    // review round 1: numbers, amounts and question marks on acknowledgements and goodbyes
    'ok, 20%?',
    'ok 50%',
    'thanks 100',
    'hi 2026',
    'cool 1.5',
    'great, $500',
    "that's all?",
    'later?',
    'ok?',
    'good?',
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
    expect(t).toMatch(/same question in the same conversation always gets the same answer/);
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

describe('review round 1: real follow-ups and data names win over small talk', () => {
  it('"how is it going?" about a remembered subject is a follow-up, as on main', async () => {
    for (const q of ['how is it going?', "how's it going?", 'how is it going']) {
      const r = await ask(['ROI of Sales Copilot', q]);
      expect(r[1], q).toContain('Sales Copilot');
      expect(r[1].split('\n')[0], q).not.toBe('**Doing well**');
    }
  });

  it('"how is it going?" with nothing to refer to is still small talk', async () => {
    expect((await last(['how is it going?'])).split('\n')[0]).toBe('**Doing well**');
  });

  it('a number typed after an answer is never acknowledged and dropped', async () => {
    const r = await ask(['What is the ROI of the CX Engineering team?', 'ok, 20%']);
    expect(r[1].split('\n')[0]).not.toBe('**Got it**');
  });

  it('a team whose name is a small-talk word is answered as data', async () => {
    // Teams come from the workload snapshots (world.ts), so rename the team there.
    const renamed = { ...CTX, workloads: (CTX.workloads ?? []).map((w, n) => (n === 0 ? { ...w, team: 'Great' } : w)) };
    const t = await last(['Great team'], renamed);
    expect(t.split('\n')[0]).not.toBe('**Got it**');
    expect(t).toContain('Great');
  });

  it('a goodbye after thanks says goodbye; identity plus how-are-you answers both', async () => {
    expect((await last(['thanks, bye'])).split('\n')[0]).toBe('**Goodbye**');
    const t = await last(['who are you, how are you?']);
    expect(t.split('\n')[0]).toBe("**I'm Frank Coster, Ratio's FinOps accountability partner**");
    expect(t).toMatch(/running well/);
    expect(t.match(/not a generative AI model/g)).toHaveLength(1);
  });

  it('counts are pluralized correctly', async () => {
    const id = CTX.initiatives[0].id;
    const one = { ...CTX, initiatives: CTX.initiatives.slice(0, 1), workloads: (CTX.workloads ?? []).filter((w) => w.id === id), omitted: [] };
    const t = await last(['Hi Frank'], one);
    expect(t).toMatch(/In this view: 1 workload across 1 team\b/);
    expect(t).not.toMatch(/1 workloads|1 teams/);
  });
});

describe('review round 2: greeting idioms are not back-references', () => {
  const subjects = ['ROI of Sales Copilot', 'What is the ROI of the CX Engineering team?'];

  it.each([
    ['hi there', "**Hi — I'm Frank Coster**"],
    ['Hey there!', "**Hey — I'm Frank Coster**"],
    ['hello there', "**Hello — I'm Frank Coster**"],
    ['appreciate it', "**You're welcome**"],
    ['thanks, appreciate it', "**You're welcome**"],
  ])('"%s" after an answer is small talk', async (q, header) => {
    for (const s of subjects) {
      const r = await ask([s, q]);
      expect(r[1].split('\n')[0], `${s} / ${q}`).toBe(header);
    }
  });

  it('a real "it" next to a greeting idiom is still a follow-up', async () => {
    const r = await ask(['ROI of Sales Copilot', 'hi there, how is it going?']);
    expect(r[1]).toContain('Sales Copilot');
    expect(r[1].split('\n')[0]).not.toMatch(/Frank Coster/);
  });

  it('the subject survives the idiom', async () => {
    const r = await ask(['What is the ROI of the CX Engineering team?', 'appreciate it', 'what about its workloads?']);
    expect(r[2]).toContain('CX Engineering');
    expect(r[2]).not.toContain(UNSUPPORTED);
  });
});

describe('review round 3 (Copilot): nothing the user typed is dropped', () => {
  it.each(['Hi 分析成本', 'ok ５０', 'thanks ¾', 'hello olá', 'ok?!', "that's all?!", 'ok? thanks', 'bye?.', 'ok؟', 'ok‽', 'ok⁇', 'ok⁈', 'ok﹖'])('not small talk: %s', (q) => {
    expect(smallTalkKinds(q)).toBeNull();
  });

  it.each([
    ['all right', ['acknowledge']],
    ['all right, thanks', ['acknowledge', 'thanks']],
    ['Hey 👋', ['greeting']],
    ['who are you?!', ['identity']],
  ])('%s', (q, kinds) => {
    expect(smallTalkKinds(q)).toEqual(kinds);
  });

  it.each([
    ['got it', '**Got it**'],
    ['Got it!', '**Got it**'],
    ['hi   there!', "**Hi — I'm Frank Coster**"],
    ['hi, there', "**Hi — I'm Frank Coster**"],
    ['hiya there', "**Hi — I'm Frank Coster**"],
  ])('"%s" after an answer is small talk', async (q, header) => {
    const r = await ask(['ROI of Sales Copilot', q]);
    expect(r[1].split('\n')[0], q).toBe(header);
  });

  it('"got it" keeps the subject for the next follow-up', async () => {
    const r = await ask(['What is the ROI of the CX Engineering team?', 'got it', 'what about its workloads?']);
    expect(r[2]).toContain('CX Engineering');
  });
});

describe('review round 4 (Copilot): questioned phrases and R4', () => {
  it.each(['Hi Frank, ok?', "hello, that's all?", 'hey, thanks?', 'hi, bye?', 'good morning, ok?!', 'hi, ok? thanks'])('not small talk: %s', (q) => {
    expect(smallTalkKinds(q)).toBeNull();
  });

  it.each([
    ['Hi Frank, how are you?', ['greeting', 'how_are_you']],
    ['ok, who are you?', ['acknowledge', 'identity']],
    ['thanks! who are you?', ['thanks', 'identity']],
    ['hi! how are you? thanks', ['greeting', 'how_are_you', 'thanks']],
  ])('%s', (q, kinds) => {
    expect(smallTalkKinds(q)).toEqual(kinds);
  });

  it('R4: a small-talk reply that quotes monthly spend also quotes the ratio and its evidence status', async () => {
    for (const q of ['Hi Frank', 'hello', 'Good morning', 'who are you?', 'hi, how are you?']) {
      const t = await last([q]);
      expect(t, q).toMatch(/\/mo/);
      expect(t, q).toMatch(/Value \/ cost \d+\.\d×/);
      expect(t, q).toMatch(/value evidence: (assumed|projected|measured|unmarked)/);
      expect(t, q).not.toMatch(/value evidence: measured/);
    }
  });
});

describe('owner review: Frank says who he is, what he does and what he cannot do', () => {
  const R4_RATIO = /Value \/ cost -?\d+\.\d×/;
  const R4_EVIDENCE = /value evidence: (assumed|projected|measured|unmarked)/;

  it('"who are you?" names Frank and lists what he does and what he cannot do', async () => {
    const t = await last(['who are you?']);
    expect(t.split('\n')[0]).toBe("**I'm Frank Coster, Ratio's FinOps accountability partner**");
    expect(t).toContain('\nWhat I do:\n');
    expect(t).toContain("\nWhat I can't do:\n");
    expect(t).toMatch(/not a generative AI model/);
    expect(t).toMatch(/approve spend/);
    expect(t).toMatch(R4_RATIO);
    expect(t).toMatch(R4_EVIDENCE);
  });

  it('"What can you answer?" and "where do I start?" say who Frank is and what he cannot do, with R4', async () => {
    for (const q of ['What can you answer?', 'where do I start?', 'what do you do?']) {
      const t = await last([q]);
      expect(t.split('\n')[0], q).toBe('**What I can answer**');
      expect(t, q).toContain('\nWho I am:\n');
      expect(t, q).toContain("\nWhat I can't do:\n");
      expect(t, q).toMatch(R4_RATIO);
      expect(t, q).toMatch(R4_EVIDENCE);
    }
  });

  it('the capability answer pluralizes counts', async () => {
    const id = CTX.initiatives[0].id;
    const one = { ...CTX, initiatives: CTX.initiatives.slice(0, 1), workloads: (CTX.workloads ?? []).filter((w) => w.id === id), omitted: [] };
    const t = await last(['What can you answer?'], one);
    expect(t).toMatch(/1 workload across 1 team\b/);
    expect(t).not.toMatch(/1 workloads|1 teams/);
  });

  it.each(['hi, ¿ok', '¿hi, ok', 'hi ¿ok', 'hola ¿ok'])('an opened Spanish question is not small talk: %s', (q) => {
    expect(smallTalkKinds(q)).toBeNull();
  });
});

describe('review round 6: no overclaims', () => {
  it('evidence status is claimed for Value / cost, not for every figure', async () => {
    for (const q of ['who are you?', 'What can you answer?']) expect(await last([q]), q).not.toMatch(/evidence status of every figure/);
  });

  it('"measured outcomes" is listed as missing only when the data holds none', async () => {
    expect(await last(['who are you?'])).toMatch(/measured outcomes/);
    const measured = {
      ...CTX,
      initiatives: CTX.initiatives.map((i) => ({ ...i, valueEvidenceStatus: 'measured' as const })),
      workloads: (CTX.workloads ?? []).map((w) => ({ ...w, valueEvidenceStatus: 'measured' as const })),
    };
    for (const q of ['who are you?', 'What can you answer?']) {
      const t = await last([q], measured);
      expect(t, q).toMatch(/value evidence: measured/);
      expect(t, q).not.toMatch(/measured outcomes/);
    }
  });
});

describe('review round 9 (Copilot): punctuation and emoji inside idioms', () => {
  it.each([
    ['hi 👋 there!', "**Hi — I'm Frank Coster**"],
    ['hello — there!', "**Hello — I'm Frank Coster**"],
    ['got… it', '**Got it**'],
    ['got it!!', '**Got it**'],
  ])('"%s" after an answer is small talk', async (q, header) => {
    const r = await ask(['ROI of Sales Copilot', q]);
    expect(r[1].split('\n')[0], q).toBe(header);
  });

  it('"how\'s it going?" after an answer is still a follow-up', async () => {
    const r = await ask(['ROI of Sales Copilot', "how's it going?"]);
    expect(r[1]).toContain('Sales Copilot');
    expect(r[1].split('\n')[0]).not.toMatch(/Frank Coster|Doing well/);
  });
});

describe('review round 10: the small-talk gate and the analytic path agree on back-references', () => {
  it.each([
    ['thanks there 🙏', "**You're welcome**"],
    ['see you there 👋', '**Goodbye**'],
  ])('"%s" after an answer stays small talk, never the refusal', async (q, header) => {
    for (const s of ['ROI of Sales Copilot', 'Show the workloads in Legal']) {
      const r = await ask([s, q]);
      expect(r[1].split('\n')[0], `${s} / ${q}`).toBe(header);
      expect(r[1]).not.toContain(UNSUPPORTED);
    }
  });
});
