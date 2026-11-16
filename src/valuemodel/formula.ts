// A bounded formula language for user-defined KPIs and value cases. Never JavaScript, SQL or spreadsheet code: a
// small recursive-descent parser builds a tree, a type pass checks units, and an exact evaluator runs it.
//
//   expression := comparison | sum
//   sum        := product (('+' | '-') product)*
//   product    := unary (('*' | '/') unary)*
//   unary      := '-' unary | primary
//   primary    := decimal | identifier | '(' sum ')' | fn '(' args ')'
//   fn         := min | max | if          if(<sum> <op> <sum>, <sum>, <sum>), op one of < <= > >= == !=
//
// Literals are dimensionless. Values are converted to base units on entry (hours → minutes), so mixing compatible
// units is safe; adding or comparing different dimensions is refused at definition time. A missing input or a zero
// denominator makes the result unavailable with a reason, never 0 or infinity.
import { type Rational, RationalOverflowError, add, cmp, div, mul, neg, parseDecimal, sub } from './rational';
import { type Unit, R_ONE_UNIT, describeDims, multiplyUnits, sameDimension } from './units';

export const FORMULA_ENGINE_VERSION = 'ratio-formula/1';
export const FORMULA_LIMITS = Object.freeze({ maxLength: 1000, maxNodes: 128, maxDepth: 24, maxReferences: 32 });

type CmpOp = '<' | '<=' | '>' | '>=' | '==' | '!=';
export type Node =
  | { t: 'num'; v: Rational }
  | { t: 'ref'; name: string }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; a: Node; b: Node }
  | { t: 'call'; fn: 'min' | 'max'; args: Node[] }
  | { t: 'if'; op: CmpOp; l: Node; r: Node; then: Node; else: Node };

export class FormulaError extends Error {
  readonly code = 'FORMULA_INVALID';
  constructor(what: string) {
    super(what);
    this.name = 'FormulaError';
  }
}

type Tok = { k: 'num' | 'id' | 'op'; s: string; at: number };
const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|[-+*/(),<>]))/y;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  TOKEN_RE.lastIndex = 0;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    TOKEN_RE.lastIndex = i;
    const m = TOKEN_RE.exec(src);
    if (!m) throw new FormulaError(`unexpected character at position ${i + 1}`);
    const at = i;
    i = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) out.push({ k: 'num', s: m[1], at });
    else if (m[2] !== undefined) out.push({ k: 'id', s: m[2], at });
    else out.push({ k: 'op', s: m[3], at });
  }
  return out;
}

const CMP_OPS: readonly string[] = ['<', '<=', '>', '>=', '==', '!='];
const RESERVED = new Set(['min', 'max', 'if']);

/** Parses a formula into a tree, enforcing the length, node, depth and reference limits. */
export function parseFormula(src: unknown): Node {
  if (typeof src !== 'string' || src.trim() === '') throw new FormulaError('formula must be a non-empty string');
  if (src.length > FORMULA_LIMITS.maxLength) throw new FormulaError(`formula longer than ${FORMULA_LIMITS.maxLength} characters`);
  const toks = tokenize(src);
  let p = 0;
  let nodes = 0;
  const count = <T extends Node>(n: T): T => {
    if (++nodes > FORMULA_LIMITS.maxNodes) throw new FormulaError(`formula has more than ${FORMULA_LIMITS.maxNodes} parts`);
    return n;
  };
  const peek = () => toks[p];
  const isOp = (s: string) => peek()?.k === 'op' && peek().s === s;
  const expect = (s: string) => {
    if (!isOp(s)) throw new FormulaError(`expected "${s}"${peek() ? ` at position ${peek().at + 1}` : ' at the end'}`);
    p++;
  };
  const guard = (depth: number) => {
    if (depth > FORMULA_LIMITS.maxDepth) throw new FormulaError(`formula nests deeper than ${FORMULA_LIMITS.maxDepth} levels`);
  };

  function sum(depth: number): Node {
    guard(depth);
    let n = product(depth + 1);
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].s as '+' | '-';
      n = count({ t: 'bin', op, a: n, b: product(depth + 1) });
    }
    return n;
  }
  function product(depth: number): Node {
    guard(depth);
    let n = unary(depth + 1);
    while (isOp('*') || isOp('/')) {
      const op = toks[p++].s as '*' | '/';
      n = count({ t: 'bin', op, a: n, b: unary(depth + 1) });
    }
    return n;
  }
  function unary(depth: number): Node {
    guard(depth);
    if (isOp('-')) {
      p++;
      return count({ t: 'neg', a: unary(depth + 1) });
    }
    return primary(depth + 1);
  }
  function primary(depth: number): Node {
    guard(depth);
    const t = peek();
    if (!t) throw new FormulaError('formula ends unexpectedly');
    if (t.k === 'num') {
      p++;
      const v = parseDecimal(t.s);
      if (v === null) throw new FormulaError(`number at position ${t.at + 1} is too long`);
      return count({ t: 'num', v });
    }
    if (t.k === 'id') {
      p++;
      if (t.s === 'min' || t.s === 'max') {
        expect('(');
        const args = [sum(depth + 1)];
        while (isOp(',')) {
          p++;
          args.push(sum(depth + 1));
        }
        expect(')');
        if (args.length < 2) throw new FormulaError(`${t.s} needs at least two arguments`);
        return count({ t: 'call', fn: t.s, args });
      }
      if (t.s === 'if') {
        expect('(');
        const l = sum(depth + 1);
        const o = peek();
        if (!o || o.k !== 'op' || !CMP_OPS.includes(o.s)) throw new FormulaError('if needs a comparison (<, <=, >, >=, ==, !=) as its first argument');
        p++;
        const r = sum(depth + 1);
        expect(',');
        const then = sum(depth + 1);
        expect(',');
        const els = sum(depth + 1);
        expect(')');
        return count({ t: 'if', op: o.s as CmpOp, l, r, then, else: els });
      }
      if (isOp('(')) throw new FormulaError('only min, max and if may be called');
      return count({ t: 'ref', name: t.s });
    }
    if (t.s === '(') {
      p++;
      const n = sum(depth + 1);
      expect(')');
      return n;
    }
    throw new FormulaError(`unexpected "${t.s}" at position ${t.at + 1}`);
  }

  const tree = sum(0);
  if (p < toks.length) throw new FormulaError(`unexpected "${toks[p].s}" at position ${toks[p].at + 1}`);
  const refs = references(tree);
  if (refs.length > FORMULA_LIMITS.maxReferences) throw new FormulaError(`formula references more than ${FORMULA_LIMITS.maxReferences} inputs`);
  for (const r of refs) if (RESERVED.has(r)) throw new FormulaError(`"${r}" is a function name`);
  return tree;
}

/** Distinct input names a formula reads, in first-use order. */
export function references(n: Node): string[] {
  const seen: string[] = [];
  const walk = (x: Node): void => {
    switch (x.t) {
      case 'num': return;
      case 'ref': if (!seen.includes(x.name)) seen.push(x.name); return;
      case 'neg': return walk(x.a);
      case 'bin': walk(x.a); return walk(x.b);
      case 'call': return x.args.forEach(walk);
      case 'if': [x.l, x.r, x.then, x.else].forEach(walk);
    }
  };
  walk(n);
  return seen;
}

/** Infers the unit of a formula from the units of its inputs; throws FormulaError on any dimension mismatch. */
export function inferUnit(n: Node, unitOf: (name: string) => Unit | undefined): Unit {
  const go = (x: Node): Unit => {
    switch (x.t) {
      case 'num': return R_ONE_UNIT;
      case 'ref': {
        const u = unitOf(x.name);
        if (!u) throw new FormulaError(`"${x.name}" is not a declared input`);
        return u;
      }
      case 'neg': return go(x.a);
      case 'bin': {
        const [a, b] = [go(x.a), go(x.b)];
        if (x.op === '*') return multiplyUnits(a, b, 1);
        if (x.op === '/') return multiplyUnits(a, b, -1);
        if (!sameDimension(a, b)) throw new FormulaError(`cannot ${x.op === '+' ? 'add' : 'subtract'} ${describeDims(b)} ${x.op === '+' ? 'to' : 'from'} ${describeDims(a)}`);
        return { dims: a.dims, factor: R_ONE_UNIT.factor };
      }
      case 'call': {
        const us = x.args.map(go);
        for (const u of us.slice(1)) if (!sameDimension(us[0], u)) throw new FormulaError(`${x.fn} arguments must share one dimension`);
        return { dims: us[0].dims, factor: R_ONE_UNIT.factor };
      }
      case 'if': {
        const [l, r] = [go(x.l), go(x.r)];
        if (!sameDimension(l, r)) throw new FormulaError(`cannot compare ${describeDims(l)} with ${describeDims(r)}`);
        const [t, e] = [go(x.then), go(x.else)];
        if (!sameDimension(t, e)) throw new FormulaError('both branches of if must share one dimension');
        return { dims: t.dims, factor: R_ONE_UNIT.factor };
      }
    }
  };
  const u = go(n);
  // Every intermediate value is held in base units, so the result's factor is 1 in base units.
  return { dims: u.dims, factor: R_ONE_UNIT.factor };
}

export type EvalResult = { ok: true; value: Rational } | { ok: false; reason: 'missing_input' | 'zero_denominator' | 'overflow'; detail: string };

/** Evaluates a type-checked tree over base-unit values. `valueOf` returns null for a missing input. */
export function evaluate(n: Node, valueOf: (name: string) => Rational | null): EvalResult {
  class Unavailable extends Error {
    constructor(readonly reason: 'missing_input' | 'zero_denominator', readonly detail: string) {
      super(detail);
    }
  }
  const go = (x: Node): Rational => {
    switch (x.t) {
      case 'num': return x.v;
      case 'ref': {
        const v = valueOf(x.name);
        if (v === null) throw new Unavailable('missing_input', `no value for "${x.name}"`);
        return v;
      }
      case 'neg': return neg(go(x.a));
      case 'bin': {
        const [a, b] = [go(x.a), go(x.b)];
        if (x.op === '+') return add(a, b);
        if (x.op === '-') return sub(a, b);
        if (x.op === '*') return mul(a, b);
        const q = div(a, b);
        if (q === null) throw new Unavailable('zero_denominator', 'a denominator is zero');
        return q;
      }
      case 'call': {
        const vs = x.args.map(go);
        return vs.reduce((m, v) => ((x.fn === 'min' ? cmp(v, m) < 0 : cmp(v, m) > 0) ? v : m));
      }
      case 'if': {
        const c = cmp(go(x.l), go(x.r));
        const hit = x.op === '<' ? c < 0 : x.op === '<=' ? c <= 0 : x.op === '>' ? c > 0 : x.op === '>=' ? c >= 0 : x.op === '==' ? c === 0 : c !== 0;
        return hit ? go(x.then) : go(x.else);
      }
    }
  };
  try {
    return { ok: true, value: go(n) };
  } catch (e) {
    if (e instanceof Unavailable) return { ok: false, reason: e.reason, detail: e.detail };
    if (e instanceof RationalOverflowError) return { ok: false, reason: 'overflow', detail: e.message };
    throw e;
  }
}
