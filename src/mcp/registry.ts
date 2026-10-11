// The closed tool registry (DESIGN 3.3, M1; checklist 5.4). Purpose: build, check and
// freeze the list of tools once, at module load, and expose lookup and descriptors.
// Trust boundary: there is no register function and no export that adds, replaces or
// removes a tool at runtime; the array and every definition and schema are frozen.
// assertRegistryInvariants runs at load and throws if any tool is not a read, has a
// write-shaped name, names a provider method that is not a read, has an unbounded or
// free-text argument, or takes a tenant, account or user argument. A bad definition
// stops the module from loading, so a bad registry is never served.
import { PROVIDER_READ_METHODS } from './provider';
import { compileSchema, type ObjectSchema, type Schema, type Validator } from './schema';
import { TOOL_CLASSES, TOOL_DEFINITIONS, type ToolDefinition } from './tools';

export const MAX_TOOLS = 32;
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** Longest tool name the handler will look up. */
export const MAX_TOOL_NAME_CHARS = 64;
/** A whole-token denylist of write verbs. Defense in depth: the control is that only read tools exist. */
export const WRITE_VERBS: readonly string[] = Object.freeze([
  'create', 'update', 'delete', 'remove', 'set', 'put', 'post', 'write', 'apply', 'approve', 'execute', 'run', 'send', 'submit',
  'modify', 'edit', 'drop', 'insert', 'upsert', 'patch', 'grant', 'revoke', 'enable', 'disable', 'reset', 'import', 'upload', 'sync',
  'trigger', 'start', 'stop', 'cancel', 'commit', 'purchase', 'buy', 'reserve', 'rollback', 'restart', 'kill', 'throttle', 'pause', 'resume',
]);
/** Argument names that would let a caller choose scope. Matched as lower-case substrings. */
export const SCOPE_ARG_FRAGMENTS: readonly string[] = Object.freeze([
  'tenant', 'account', 'org', 'user', 'principal', 'role', 'subject', 'token', 'env', 'scope', 'credential', 'password', 'secret',
]);

export type ToolDescriptor = Readonly<{
  name: string;
  title: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations: Readonly<{ readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false }>;
}>;

export interface RegisteredTool {
  readonly def: ToolDefinition;
  readonly validateInput: Validator;
  readonly validateData: Validator;
  readonly descriptor: ToolDescriptor;
}

class RegistryInvariantError extends Error {
  constructor(readonly code: string) {
    super(`MCP registry invariant violated: ${code}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Walk every string property of an input schema; each must be an enum or a short, patterned string. */
function checkInputProperties(schema: ObjectSchema): void {
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const lower = name.toLowerCase();
    if (SCOPE_ARG_FRAGMENTS.some((f) => lower.includes(f))) throw new RegistryInvariantError('scope_argument');
    const visit = (s: Schema): void => {
      if (s.type === 'string' && s.enum === undefined && (s.pattern === undefined || (s.maxLength ?? Infinity) > 64)) {
        throw new RegistryInvariantError('free_text_argument');
      }
      if (s.type === 'array') visit(s.items);
      if (s.type === 'object') throw new RegistryInvariantError('nested_argument_object');
    };
    visit(prop);
  }
}

/** Throws RegistryInvariantError on the first violation. Exported so tests can feed it bad definitions. */
export function assertRegistryInvariants(defs: readonly ToolDefinition[]): void {
  if (defs.length < 1 || defs.length > MAX_TOOLS) throw new RegistryInvariantError('tool_count');
  const seen = new Set<string>();
  for (const def of defs) {
    if (typeof def.name !== 'string' || !TOOL_NAME_PATTERN.test(def.name)) throw new RegistryInvariantError('name');
    if (seen.has(def.name)) throw new RegistryInvariantError('duplicate_name');
    seen.add(def.name);
    if (def.access !== 'read') throw new RegistryInvariantError('not_read_only');
    if (def.name.split('_').some((token) => WRITE_VERBS.includes(token))) throw new RegistryInvariantError('write_shaped_name');
    const method: string = def.providerMethod;
    if (!(PROVIDER_READ_METHODS as readonly string[]).includes(method) || !/^(get|list)[A-Z]/.test(method)) {
      throw new RegistryInvariantError('provider_method');
    }
    if (def.classes.length === 0 || !def.classes.every((c) => TOOL_CLASSES.includes(c))) throw new RegistryInvariantError('classes');
    if (typeof def.sensitive !== 'boolean') throw new RegistryInvariantError('sensitive_flag');
    if (def.onSecret !== 'reject' && def.onSecret !== 'redact') throw new RegistryInvariantError('on_secret');
    if (def.title.length < 1 || def.title.length > 80 || def.description.length < 1 || def.description.length > 600) throw new RegistryInvariantError('text_length');
    if (def.inputSchema.type !== 'object' || def.inputSchema.additionalProperties !== false) throw new RegistryInvariantError('input_schema_open');
    checkInputProperties(def.inputSchema);
    compileSchema(def.inputSchema); // throws SchemaLintError for an unbounded or unsupported schema
    compileSchema(def.outputSchema);
  }
}

function build(defs: readonly ToolDefinition[]): readonly RegisteredTool[] {
  assertRegistryInvariants(defs);
  const tools = defs.map((def): RegisteredTool => {
    const descriptor: ToolDescriptor = {
      name: def.name,
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema as unknown as Record<string, unknown>,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    };
    return { def, validateInput: compileSchema(def.inputSchema), validateData: compileSchema(def.outputSchema), descriptor };
  });
  return deepFreeze(tools);
}

/** The closed, frozen registry. */
export const TOOL_REGISTRY: readonly RegisteredTool[] = build(TOOL_DEFINITIONS);

const BY_NAME: ReadonlyMap<string, RegisteredTool> = new Map(TOOL_REGISTRY.map((t) => [t.def.name, t]));

/** Exact, own-name lookup; a non-string, an unknown name and a prototype key all return undefined. */
export function findTool(name: unknown): RegisteredTool | undefined {
  return typeof name === 'string' ? BY_NAME.get(name) : undefined;
}

/** A plain, unfrozen copy of a descriptor, safe to hand to a transport that may mutate it. */
export function descriptorCopy(tool: RegisteredTool): ToolDescriptor {
  return JSON.parse(JSON.stringify(tool.descriptor)) as ToolDescriptor;
}

