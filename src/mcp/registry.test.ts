// Closed-registry and read-only invariants (checklist 5.4/5.5).
import { describe, expect, it } from 'vitest';
import { PROVIDER_READ_METHODS } from './provider';
import { assertRegistryInvariants, findTool, TOOL_REGISTRY, WRITE_VERBS } from './registry';
import * as registryModule from './registry';
import { TOOL_DEFINITIONS, type ToolDefinition } from './tools';

const good = TOOL_DEFINITIONS[0];
const mutate = (over: Partial<Record<keyof ToolDefinition, unknown>>): ToolDefinition => ({ ...good, ...over }) as ToolDefinition;
const code = (defs: ToolDefinition[]): string => {
  try { assertRegistryInvariants(defs); return 'ok'; } catch (e) { return (e as { code?: string }).code ?? String(e); }
};

describe('closed registry', () => {
  it('holds exactly the expected read tools', () => {
    expect(TOOL_REGISTRY.map((t) => t.def.name).sort()).toEqual([
      'get_allocation_summary', 'get_budget_status', 'get_commitment_coverage', 'get_forecast', 'get_spend_summary', 'list_findings',
    ]);
  });
  it('every tool is read-only, read-named, and bound to a provider read method', () => {
    for (const t of TOOL_REGISTRY) {
      expect(t.def.access).toBe('read');
      expect(t.def.name.split('_').some((x) => WRITE_VERBS.includes(x))).toBe(false);
      expect(PROVIDER_READ_METHODS).toContain(t.def.providerMethod);
      expect(t.def.providerMethod).toMatch(/^(get|list)[A-Z]/);
      expect(t.descriptor.annotations.readOnlyHint).toBe(true);
    }
    expect(PROVIDER_READ_METHODS.every((m) => /^(get|list)[A-Z]/.test(m))).toBe(true);
  });
  it('no write tool exists by name', () => {
    for (const verb of WRITE_VERBS) for (const t of TOOL_REGISTRY) expect(t.def.name.split('_')).not.toContain(verb);
    for (const n of ['create_budget', 'update_budget', 'apply_remediation', 'delete_finding', 'set_threshold', 'approve_change', 'run_query']) expect(findTool(n)).toBeUndefined();
  });
  it('exports no way to register, add or remove a tool', () => {
    const names = Object.keys(registryModule);
    expect(names.filter((n) => /register|add|remove|delete|set|define/i.test(n) && n !== 'assertRegistryInvariants')).toEqual([]);
  });
  it('is frozen all the way down', () => {
    expect(Object.isFrozen(TOOL_REGISTRY)).toBe(true);
    expect(Object.isFrozen(TOOL_DEFINITIONS)).toBe(true);
    for (const t of TOOL_REGISTRY) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(Object.isFrozen(t.descriptor)).toBe(true);
      expect(Object.isFrozen(t.def.inputSchema)).toBe(true);
    }
    expect(() => (TOOL_REGISTRY as unknown as unknown[]).push({})).toThrow();
    expect(() => { (TOOL_REGISTRY[0].def as { name: string }).name = 'x'; }).toThrow();
  });
  it('no tool takes a scope argument and every input is bounded', () => {
    for (const t of TOOL_REGISTRY) {
      expect(t.def.inputSchema.additionalProperties).toBe(false);
      for (const name of Object.keys(t.def.inputSchema.properties ?? {})) expect(name).not.toMatch(/tenant|account|org|user|principal|role|subject|token|env|scope/i);
    }
  });
  it('finds by exact own name only', () => {
    for (const n of ['__proto__', 'constructor', 'toString', 'GET_SPEND_SUMMARY', ' get_spend_summary', '', 1, null, {}]) expect(findTool(n)).toBeUndefined();
    expect(findTool('get_spend_summary')).toBeDefined();
  });
});

describe('startup invariant rejects bad definitions', () => {
  it('accepts the real list', () => expect(code([...TOOL_DEFINITIONS])).toBe('ok'));
  it('rejects a write tool', () => {
    expect(code([mutate({ access: 'write' })])).toBe('not_read_only');
    expect(code([mutate({ name: 'update_budget' })])).toBe('write_shaped_name');
    expect(code([mutate({ name: 'get_and_delete' })])).toBe('write_shaped_name');
    expect(code([mutate({ providerMethod: 'updateBudget' })])).toBe('provider_method');
    expect(code([mutate({ providerMethod: 'constructor' })])).toBe('provider_method');
  });
  it('rejects bad names, duplicates and counts', () => {
    expect(code([mutate({ name: 'Get' })])).toBe('name');
    expect(code([mutate({ name: '' })])).toBe('name');
    expect(code([good, good])).toBe('duplicate_name');
    expect(code([])).toBe('tool_count');
  });
  it('rejects scope, free-text and open arguments', () => {
    const input = (properties: object, extra = {}) => mutate({ inputSchema: { type: 'object', properties, additionalProperties: false, ...extra } });
    expect(code([input({ tenant_id: { type: 'string', maxLength: 8, pattern: '^a$' } })])).toBe('scope_argument');
    expect(code([input({ user: { type: 'string', enum: ['a'] } })])).toBe('scope_argument');
    expect(code([input({ note: { type: 'string', maxLength: 64 } })])).toBe('free_text_argument');
    expect(code([input({ note: { type: 'string', maxLength: 500, pattern: '^a' } })])).toBe('free_text_argument');
    expect(code([input({ o: { type: 'object', additionalProperties: false } })])).toBe('nested_argument_object');
    expect(code([input({}, { additionalProperties: true })])).toBe('input_schema_open');
  });
  it('rejects bad metadata', () => {
    expect(code([mutate({ classes: [] })])).toBe('classes');
    expect(code([mutate({ onSecret: 'ignore' })])).toBe('on_secret');
    expect(code([mutate({ sensitive: 'yes' })])).toBe('sensitive_flag');
    expect(code([mutate({ description: '' })])).toBe('text_length');
  });
});
