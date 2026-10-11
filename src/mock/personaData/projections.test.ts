import { describe, it, expect } from 'vitest';
import oracle from './oracle.fixture.json';
import { DATASET, ENVS, TEAMS, reviseDataset } from './dataset';
import type { Dataset } from './dataset';
import { filterLines, inScope, isEmptyScope } from './scope';
import type { Scope } from './scope';
import { PERSONA_IDS, project } from './projections';
import type { PersonaId, PersonaView } from './projections';

// The expected numbers all come from oracle.fixture.json, which was produced by
// a one-off script using plain integer arithmetic and checked by hand. Only
// the data and types are imported from the code under test; no expectation is
// derived by calling a projection.

const ALL: Scope = { teams: '*', envs: [...ENVS] };
const FULL_SCOPE_PERSONAS: PersonaId[] = ['cto', 'finops_lead', 'finance', 'procurement', 'auditor'];

function sumCents(rows: { cents: number }[]): number {
  let t = 0;
  for (const r of rows) t += r.cents;
  return t;
}

function engScope(team: string, envs: string[] = [...ENVS]): Scope {
  return { teams: [team], envs };
}

function keyed(rows: { key: string; cents: number }[]) {
  return rows.map((r) => ({ key: r.key, cents: r.cents }));
}

describe('dataset and oracle sanity', () => {
  it('dataset_is_integer_cents_only', () => {
    expect(DATASET.lines).toHaveLength(27);
    for (const l of DATASET.lines) {
      expect(Number.isSafeInteger(l.cents)).toBe(true);
      expect(l.cents).toBeGreaterThan(0);
    }
    expect(new Set(DATASET.lines.map((l) => l.id)).size).toBe(27);
    expect(DATASET.teams).toHaveLength(3);
    expect(DATASET.envs).toHaveLength(3);
    for (const t of TEAMS) for (const e of ENVS) {
      expect(DATASET.lines.filter((l) => l.team === t && l.env === e).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('dataset_exposes_float_error_in_a_naive_dollar_sum', () => {
    let naive = 0;
    for (const l of DATASET.lines) naive += l.cents / 100;
    // The exact answer is an integer number of cents; the float sum drifts.
    expect(naive).not.toBe(oracle.org.totalCents / 100);
    expect(Math.round(naive * 100)).toBe(oracle.org.totalCents);
  });

  it('oracle_agrees_with_an_independent_sum_of_the_dataset', () => {
    let total = BigInt(0);
    for (const l of DATASET.lines) total += BigInt(l.cents);
    expect(total).toBe(BigInt(oracle.org.totalCents));
    for (const t of TEAMS) {
      let s = BigInt(0);
      for (const l of DATASET.lines) if (l.team === t) s += BigInt(l.cents);
      expect(Number(s)).toBe(oracle.engLeads[t as keyof typeof oracle.engLeads].totalCents);
    }
    expect(oracle.org.lineCount).toBe(DATASET.lines.length);
  });
});

describe('scope', () => {
  it('empty_lists_select_nothing_and_star_selects_every_listed_env', () => {
    const l = DATASET.lines[0];
    expect(inScope(l, { teams: [], envs: ['dev'] })).toBe(false);
    expect(inScope(l, { teams: '*', envs: [] })).toBe(false);
    expect(inScope(l, { teams: '*', envs: ['dev'] })).toBe(true);
    expect(isEmptyScope({ teams: [], envs: [] })).toBe(true);
    expect(filterLines(DATASET.lines, { teams: ['Nope'], envs: ['dev'] })).toEqual([]);
  });
});

describe('persona projections', () => {
  it('cto_rollup_total_equals_finops_drilldown_total', () => {
    const cto = project('cto', DATASET, ALL);
    const fin = project('finops_lead', DATASET, ALL);
    expect(cto.shape).toBe('rollup');
    expect(fin.shape).toBe('drilldown');
    expect(cto.totalCents).toBe(fin.totalCents);
    expect(cto.totalCents).toBe(oracle.org.totalCents);
    expect(sumCents(cto.rows)).toBe(cto.totalCents);
    expect(sumCents(fin.rows)).toBe(fin.totalCents);
    // The roll-up carries no line items.
    for (const r of cto.rows) {
      expect(r).not.toHaveProperty('description');
      expect(r).not.toHaveProperty('vendor');
    }
    expect(cto.rows.length).toBeLessThan(fin.rows.length);
  });

  it('finops_drilldown_total_equals_sum_of_team_views', () => {
    const fin = project('finops_lead', DATASET, ALL);
    let teamSum = 0;
    let teamRows = 0;
    let engSum = 0;
    for (const t of TEAMS) {
      const tv = project('finops_lead', DATASET, engScope(t));
      teamSum += tv.totalCents;
      teamRows += tv.rowCount;
      engSum += project('eng_lead', DATASET, engScope(t)).totalCents;
    }
    expect(teamSum).toBe(fin.totalCents);
    expect(engSum).toBe(fin.totalCents);
    expect(teamRows).toBe(fin.rowCount);
    expect(fin.byTeam.map((x) => x.cents).reduce((a, b) => a + b, 0)).toBe(fin.totalCents);
    expect(fin.byEnv.map((x) => x.cents).reduce((a, b) => a + b, 0)).toBe(fin.totalCents);
  });

  it('finance_total_equals_cto_total_to_the_cent', () => {
    const fn = project('finance', DATASET, ALL);
    const cto = project('cto', DATASET, ALL);
    expect(fn.totalCents).toBe(cto.totalCents);
    expect(fn.totalCents).toBe(oracle.org.totalCents);
    expect(sumCents(fn.rows)).toBe(cto.totalCents);
    expect(fn.budgets).toBeDefined();
    expect(sumCents((fn.budgets ?? []).map((b) => ({ cents: b.actualCents })))).toBe(cto.totalCents);
  });

  it('each_persona_matches_committed_oracle', () => {
    const org = oracle.org;
    const fin = project('finops_lead', DATASET, ALL);
    expect(fin.byTeam).toEqual(org.byTeam);
    expect(fin.byEnv).toEqual(org.byEnv);

    for (const p of FULL_SCOPE_PERSONAS) {
      const exp = oracle.fullScope[p as keyof typeof oracle.fullScope];
      const v = project(p, DATASET, ALL);
      expect(v.persona).toBe(p);
      expect(v.shape).toBe(exp.shape);
      expect(v.totalCents).toBe(exp.totalCents);
      expect(v.rowCount).toBe(exp.rowCount);
      expect(keyed(v.rows)).toEqual(exp.rows.map((r) => ({ key: r.key, cents: r.cents })));
    }

    const fn = project('finance', DATASET, ALL);
    expect(fn.budgets).toEqual(oracle.fullScope.finance.budgets);

    const pr = project('procurement', DATASET, ALL);
    expect(pr.rows.map((r) => [r.key, r.usageCents, r.commitmentCents, r.commitmentLines])).toEqual(
      oracle.fullScope.procurement.rows.map((r) => {
        const x = r as { key: string; usageCents: number; commitmentCents: number; commitmentLines: number };
        return [x.key, x.usageCents, x.commitmentCents, x.commitmentLines];
      }),
    );

    expect(project('auditor', DATASET, ALL).readOnly).toBe(true);

    for (const t of TEAMS) {
      const exp = oracle.engLeads[t as keyof typeof oracle.engLeads];
      const v = project('eng_lead', DATASET, engScope(t));
      expect(v.shape).toBe('drilldown');
      expect(v.totalCents).toBe(exp.totalCents);
      expect(v.rowCount).toBe(exp.lineCount);
      expect(keyed(v.rows)).toEqual(exp.rows);
      expect(v.byTeam).toEqual(exp.byTeam);
      expect(v.byEnv).toEqual(exp.byEnv);

      const exp2 = oracle.engLeadsDevTest[t as keyof typeof oracle.engLeadsDevTest];
      const v2 = project('eng_lead', DATASET, engScope(t, ['dev', 'test']));
      expect(v2.totalCents).toBe(exp2.totalCents);
      expect(keyed(v2.rows)).toEqual(exp2.rows);
    }

    const two = oracle.engLeadTwoTeams;
    const tv = project('eng_lead', DATASET, { teams: two.teams, envs: two.envs });
    expect(tv.totalCents).toBe(two.totalCents);
    expect(tv.rowCount).toBe(two.lineCount);
  });

  it('eng_lead_view_contains_no_other_team_rows_counts_or_totals', () => {
    for (const t of TEAMS) {
      const v = project('eng_lead', DATASET, engScope(t));
      const others = TEAMS.filter((x) => x !== t);
      const text = JSON.stringify(v);
      for (const o of others) expect(text).not.toContain(o);
      for (const r of v.rows) expect(r.team).toBe(t);
      expect(v.byTeam.map((x) => x.team)).toEqual([t]);
      expect(v.rowCount).toBe(DATASET.lines.filter((l) => l.team === t).length);
      expect(v.rowCount).toBeLessThan(DATASET.lines.length);
      expect(v.totalCents).toBeLessThan(oracle.org.totalCents);
      // Neither the org total nor another team's total appears as a figure.
      const figures = [oracle.org.totalCents, ...others.map((o) => oracle.engLeads[o as keyof typeof oracle.engLeads].totalCents)];
      const present = new Set<number>([v.totalCents, v.rowCount, ...v.rows.map((r) => r.cents), ...v.byTeam.map((x) => x.cents), ...v.byEnv.map((x) => x.cents)]);
      for (const f of figures) expect(present.has(f)).toBe(false);
      expect(v.budgets).toBeUndefined();
    }
  });

  it('eng_lead_rollup_is_computed_after_the_scope_filter', () => {
    const before = project('eng_lead', DATASET, engScope('Platform'));
    // Change a line owned by another team (L14 belongs to Payments).
    const edited = reviseDataset(DATASET, 'L14', 999999999);
    expect(edited.lines.find((l) => l.id === 'L14')?.team).toBe('Payments');
    const after = project('eng_lead', edited, engScope('Platform'));
    expect({ ...after, revision: 0 }).toEqual({ ...before, revision: 0 });
    expect(after.totalCents).toBe(oracle.engLeads.Platform.totalCents);
    expect(after.byEnv).toEqual(oracle.engLeads.Platform.byEnv);
    expect(after.byTeam).toEqual(oracle.engLeads.Platform.byTeam);
  });

  it('dataset_revision_bump_changes_every_persona_view_together', () => {
    const bump = oracle.revisionBump;
    const revised: Dataset = reviseDataset(DATASET, bump.lineId, bump.newCents);
    expect(revised.revision).toBe(bump.revision);
    expect(DATASET.revision).toBe(1); // the base is not mutated
    expect(bump.newCents).not.toBe(bump.oldCents);

    const revisions = new Set<number>();
    for (const p of FULL_SCOPE_PERSONAS) {
      const old = project(p, DATASET, ALL);
      const now = project(p, revised, ALL);
      const exp = bump.fullScope[p as keyof typeof bump.fullScope];
      expect(old.revision).toBe(1);
      expect(now.revision).toBe(2);
      revisions.add(now.revision);
      expect(now.totalCents).toBe(exp.totalCents);
      expect(now.rowCount).toBe(exp.rowCount);
      expect(now.totalCents - old.totalCents).toBe(bump.newCents - bump.oldCents);
      expect(sumCents(now.rows)).toBe(now.totalCents);
    }
    expect(revisions.size).toBe(1);

    let engSum = 0;
    for (const t of TEAMS) {
      const v = project('eng_lead', revised, engScope(t));
      expect(v.revision).toBe(2);
      expect(v.totalCents).toBe(bump.engLeadTotals[t as keyof typeof bump.engLeadTotals]);
      engSum += v.totalCents;
    }
    expect(engSum).toBe(bump.org.totalCents);
  });

  it('env_scoped_view_excludes_out_of_scope_environments_and_totals_still_sum', () => {
    for (const exp of Object.values(oracle.envScoped)) {
      const scope: Scope = { teams: '*', envs: exp.envs };
      for (const p of PERSONA_IDS) {
        const v = project(p, DATASET, scope);
        expect(v.totalCents).toBe(exp.totalCents);
        expect(sumCents(v.rows)).toBe(v.totalCents);
        expect(v.byEnv.map((x) => x.env)).toEqual(exp.byEnv.map((x) => x.env));
        for (const r of v.rows) {
          if (typeof r.env === 'string') expect(exp.envs).toContain(r.env);
        }
      }
      const fin = project('finops_lead', DATASET, scope);
      expect(fin.rowCount).toBe(exp.lineCount);
      expect(fin.rows.every((r) => exp.envs.includes(String(r.env)))).toBe(true);
    }
    const a = project('cto', DATASET, { teams: '*', envs: ['dev', 'test'] });
    const b = project('cto', DATASET, { teams: '*', envs: ['prod'] });
    expect(a.totalCents + b.totalCents).toBe(oracle.org.totalCents);
    const none = project('eng_lead', DATASET, engScope('Platform', ['dev']));
    expect(JSON.stringify(none)).not.toContain('"prod"');
  });

  it('empty_scope_returns_empty_not_everything', () => {
    const empties: Scope[] = [
      { teams: [], envs: [...ENVS] },
      { teams: '*', envs: [] },
      { teams: [], envs: [] },
      { teams: ['No Such Team'], envs: [...ENVS] },
      { teams: '*', envs: ['staging'] },
    ];
    for (const scope of empties) {
      for (const p of PERSONA_IDS) {
        const v: PersonaView = project(p, DATASET, scope);
        expect(v.rows).toEqual([]);
        expect(v.totalCents).toBe(0);
        expect(v.rowCount).toBe(0);
        expect(v.byTeam).toEqual([]);
        expect(v.byEnv).toEqual([]);
        if (v.budgets) expect(v.budgets).toEqual([]);
      }
    }
  });

  it('paged_rows_sum_to_the_total_for_every_persona', () => {
    function walk(p: PersonaId, scope: Scope, limit: number) {
      const pages: PersonaView[] = [];
      for (let offset = 0; ; offset += limit) {
        const v = project(p, DATASET, scope, { offset, limit });
        if (v.rows.length === 0) break;
        pages.push(v);
        if (pages.length > 100) throw new Error('runaway paging');
      }
      return pages;
    }
    for (const p of PERSONA_IDS) {
      const scope = p === 'eng_lead' ? engScope('Payments') : ALL;
      const whole = project(p, DATASET, scope);
      const pages = walk(p, scope, 4);
      const keys = pages.flatMap((v) => v.rows.map((r) => r.key));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(whole.rows.map((r) => r.key));
      expect(sumCents(pages.flatMap((v) => v.rows))).toBe(whole.totalCents);
      for (const v of pages) {
        expect(v.totalCents).toBe(whole.totalCents);
        expect(v.rowCount).toBe(whole.rowCount);
        expect(v.rows.length).toBeLessThanOrEqual(4);
      }
    }
    const finPages = walk('finops_lead', ALL, oracle.paging.pageSize);
    expect(finPages.map((v) => sumCents(v.rows))).toEqual(oracle.paging.finopsPageCents);
    const ctoPages = walk('cto', ALL, oracle.paging.ctoPageSize);
    expect(ctoPages.map((v) => sumCents(v.rows))).toEqual(oracle.paging.ctoPageCents);
  });

  it('invalid_page_requests_throw_and_projection_does_not_mutate_the_dataset', () => {
    const snapshot = JSON.stringify(DATASET);
    expect(() => project('cto', DATASET, ALL, { offset: -1, limit: 4 })).toThrow(RangeError);
    expect(() => project('cto', DATASET, ALL, { offset: 0, limit: 0 })).toThrow(RangeError);
    expect(() => project('cto', DATASET, ALL, { offset: 0.5, limit: 4 })).toThrow(RangeError);
    for (const p of PERSONA_IDS) project(p, DATASET, ALL);
    expect(JSON.stringify(DATASET)).toBe(snapshot);
  });
});
