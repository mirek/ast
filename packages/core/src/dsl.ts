import type { Adapter, Operation } from "./adapter.js";
import { planOperations } from "./change.js";
import type { ChangePlan } from "./change.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import type { Scalar, SourceRange } from "./model.js";
import type { CaptureMap, NavigableNodeHandle, Query } from "./query.js";
import { SelectorError, selectFrom } from "./selector.js";

export interface DslOptions { readonly uri?: string; }
export interface DslEnvironment {
  readonly sources: Readonly<Record<string, {
    readonly adapter: Adapter;
    open(args: readonly Scalar[]): Query<NavigableNodeHandle>;
  }>>;
  readonly mounts?: Readonly<Record<string, {
    readonly adapter: Adapter;
    mount(query: Query<NavigableNodeHandle, CaptureMap>): Query<NavigableNodeHandle, CaptureMap>;
  }>>;
  readonly operations?: Readonly<Record<string, {
    readonly adapter: Adapter;
    create(target: NavigableNodeHandle, args: Readonly<Record<string, Scalar>>): Operation;
  }>>;
}

export interface DslExpression { readonly source: string; readonly range: SourceRange; }
export interface DslStep { readonly kind: string; readonly source: string; readonly range: SourceRange; readonly expressions: readonly DslExpression[]; }
export interface DslPipeline { readonly source: DslStep; readonly steps: readonly DslStep[]; readonly range: SourceRange; }
export interface DslBinding { readonly name: string; readonly pipeline: DslPipeline; readonly range: SourceRange; }
export interface DslProgram {
  readonly source: string;
  readonly uri: string;
  readonly bindings: readonly DslBinding[];
  readonly pipeline: DslPipeline;
  readonly range: SourceRange;
}

export type CompiledDsl =
  | { readonly kind: "query"; readonly query: Query<unknown, CaptureMap>; readonly program: DslProgram }
  | { readonly kind: "plan"; readonly plan: () => Promise<ChangePlan>; readonly program: DslProgram };

export class DslError extends SyntaxError {
  override readonly name = "DslError";
  readonly diagnostics: readonly Diagnostic[];
  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(({ message }) => message).join("\n"));
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

const diagnostic = (code: string, message: string, uri: string, range: SourceRange): Diagnostic =>
  defineDiagnostic({ code, severity: "error", message, locations: [{ kind: "program", uri, range }] });

interface Segment { readonly text: string; readonly start: number; readonly end: number; }
const trimmed = (source: string, start: number, end: number): Segment => {
  while (start < end && /\s/u.test(source[start] ?? "")) start += 1;
  while (end > start && /\s/u.test(source[end - 1] ?? "")) end -= 1;
  return { text: source.slice(start, end), start, end };
};

const splitTopLevel = (source: string, start: number, end: number, separator: string): readonly Segment[] => {
  const values: Segment[] = [];
  let quote: string | undefined;
  let escaped = false;
  let braces = 0;
  let parentheses = 0;
  let slashRegex = false;
  let part = start;
  for (let index = start; index < end; index += 1) {
    const character = source[index] ?? "";
    if (quote !== undefined) {
      if (character === quote && !escaped) quote = undefined;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      continue;
    }
    if (slashRegex) {
      if (character === "/" && !escaped) slashRegex = false;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "/" && source[index - 1] === "~") { slashRegex = true; continue; }
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === separator && braces === 0 && parentheses === 0) {
      values.push(trimmed(source, part, index));
      part = index + 1;
    }
  }
  values.push(trimmed(source, part, end));
  return values.filter(({ text }) => text.length > 0);
};

const stepKind = (text: string): string => /^[A-Za-z][A-Za-z0-9-]*/u.exec(text)?.[0] ?? "";
const expressionsFor = (part: Segment): readonly DslExpression[] => {
  const expression = /@[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*|\$[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?n?|\b(?:true|false|null)\b/gu;
  return [...part.text.matchAll(expression)].map((match) => immutableCopy({
    source: match[0],
    range: {
      start: part.start + (match.index ?? 0),
      end: part.start + (match.index ?? 0) + match[0].length,
    },
  }));
};
const validateBalance = (source: string, uri: string): void => {
  let quote: string | undefined;
  let quoteStart = 0;
  let escaped = false;
  let braces = 0;
  let parentheses = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote !== undefined) {
      if (character === quote && !escaped) quote = undefined;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; quoteStart = index; continue; }
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    if (braces < 0 || parentheses < 0) throw new DslError([diagnostic("dsl.unbalanced", "Unexpected closing delimiter.", uri, { start: index, end: index + 1 })]);
  }
  if (quote !== undefined) throw new DslError([diagnostic("dsl.unterminated-string", "Unterminated string literal.", uri, { start: quoteStart, end: source.length })]);
  if (braces !== 0 || parentheses !== 0) throw new DslError([diagnostic("dsl.unbalanced", "Unclosed delimiter.", uri, { start: Math.max(0, source.length - 1), end: source.length })]);
};
const parsePipeline = (source: string, segment: Segment, uri: string): DslPipeline => {
  const parts = splitTopLevel(source, segment.start, segment.end, "|");
  const first = parts[0];
  if (first === undefined || !first.text.startsWith("from ")) {
    throw new DslError([diagnostic("dsl.expected-source", "A pipeline must begin with `from`.", uri, { start: segment.start, end: Math.max(segment.start + 1, segment.end) })]);
  }
  const make = (part: Segment): DslStep => immutableCopy({ kind: stepKind(part.text), source: part.text, range: { start: part.start, end: part.end }, expressions: expressionsFor(part) });
  return immutableCopy({ source: make(first), steps: parts.slice(1).map(make), range: { start: segment.start, end: segment.end } });
};

export const parseDsl = (source: string, options: DslOptions = {}): DslProgram => {
  const uri = options.uri ?? "dsl:";
  validateBalance(source, uri);
  const statements = splitTopLevel(source, 0, source.length, ";");
  if (statements.length === 0) throw new DslError([diagnostic("dsl.empty", "DSL program is empty.", uri, { start: 0, end: 0 })]);
  const bindings: DslBinding[] = [];
  for (const statement of statements.slice(0, -1)) {
    const match = /^let\s+([A-Za-z][A-Za-z0-9_-]*)\s*=\s*/u.exec(statement.text);
    if (match === null) throw new DslError([diagnostic("dsl.invalid-binding", "Expected `let name = pipeline;`.", uri, { start: statement.start, end: statement.end })]);
    const offset = statement.start + match[0].length;
    bindings.push(immutableCopy({ name: match[1] ?? "", pipeline: parsePipeline(source, trimmed(source, offset, statement.end), uri), range: { start: statement.start, end: statement.end } }));
  }
  const final = statements.at(-1);
  if (final === undefined || final.text.startsWith("let ")) throw new DslError([diagnostic("dsl.missing-result", "Program requires a final pipeline.", uri, { start: source.length, end: source.length })]);
  return immutableCopy({ source, uri, bindings, pipeline: parsePipeline(source, final, uri), range: { start: 0, end: source.length } });
};

const fail = (program: DslProgram, code: string, message: string, range: SourceRange): never => {
  throw new DslError([diagnostic(code, message, program.uri, range)]);
};

const unquote = (value: string, program: DslProgram, range: SourceRange): string => {
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) {
    return fail(program, "dsl.expected-string", "Expected a quoted string.", range);
  }
  let result = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") { result += character; continue; }
    index += 1;
    const escaped = value[index];
    if (escaped === undefined) return fail(program, "dsl.invalid-escape", "Incomplete string escape.", range);
    result += ({ n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" } as Readonly<Record<string, string>>)[escaped] ?? escaped;
  }
  return result;
};

const literal = (value: string, program: DslProgram, range: SourceRange): Scalar => {
  const source = value.trim();
  if (source.startsWith('"') || source.startsWith("'")) return unquote(source, program, range);
  if (source === "true") return true;
  if (source === "false") return false;
  if (source === "null") return null;
  if (/^-?(?:0|[1-9][0-9]*)n$/u.test(source)) return BigInt(source.slice(0, -1));
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(source)) return Number(source);
  return fail(program, "dsl.expected-literal", `Expected a scalar literal, received ${JSON.stringify(source)}.`, range);
};

const commaParts = (source: string, start: number, end: number): readonly Segment[] =>
  splitTopLevel(source, start, end, ",");

const parseFrom = (step: DslStep, program: DslProgram): { readonly name: string; readonly args: readonly Scalar[] } => {
  const match = /^from\s+([A-Za-z][A-Za-z0-9_-]*)\s*\((.*)\)$/us.exec(step.source);
  if (match === null) return fail(program, "dsl.invalid-source", "Expected `from source(arguments)`.", step.range);
  const argsSource = match[2] ?? "";
  const argsOffset = step.range.start + step.source.indexOf(argsSource);
  const args = argsSource.trim().length === 0
    ? []
    : commaParts(program.source, argsOffset, argsOffset + argsSource.length).map((part) => literal(part.text, program, { start: part.start, end: part.end }));
  return { name: match[1] ?? "", args };
};

const parseObject = (step: DslStep, keyword: string, program: DslProgram): Readonly<Record<string, Scalar>> => {
  const prefix = new RegExp(`^${keyword}\\s+[^\\s{]+\\s*`, "u").exec(step.source)?.[0] ?? `${keyword} `;
  const open = step.source.indexOf("{", Math.min(prefix.length, step.source.length));
  const close = step.source.lastIndexOf("}");
  if (open < 0 || close < open) return fail(program, "dsl.expected-object", `Expected an argument object after ${keyword}.`, step.range);
  const absolute = step.range.start + open + 1;
  const entries = commaParts(program.source, absolute, step.range.start + close);
  const result: Record<string, Scalar> = {};
  for (const entry of entries) {
    const colon = entry.text.indexOf(":");
    if (colon < 1) return fail(program, "dsl.invalid-object", "Expected `name: literal`.", { start: entry.start, end: entry.end });
    const name = entry.text.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name)) return fail(program, "dsl.invalid-name", "Invalid object field name.", { start: entry.start, end: entry.end });
    const value = entry.text.slice(colon + 1);
    result[name] = literal(value, program, { start: entry.start + colon + 1, end: entry.end });
  }
  return Object.freeze(result);
};

const isNode = (value: unknown): value is NavigableNodeHandle =>
  value !== null && typeof value === "object" && "snapshot" in value && "edges" in value;

const property = (value: unknown, path: readonly string[]): unknown => {
  let current = value;
  for (const name of path) {
    if (isNode(current)) {
      if (name === "origin") current = current.snapshot.origin;
      else if (name === "id") current = current.snapshot.id;
      else current = current.snapshot.attributes[name];
    } else if (current !== null && typeof current === "object") {
      current = (current as Readonly<Record<string, unknown>>)[name];
    } else return undefined;
  }
  return current;
};

const expressionValue = (expression: string, value: unknown, captures: CaptureMap, program: DslProgram, range: SourceRange): unknown => {
  const source = expression.trim();
  if (source.startsWith("@")) return property(value, source.slice(1).split("."));
  if (source.startsWith("$")) {
    const [name, ...path] = source.slice(1).split(".");
    if (name === "left" || name === "right") {
      if (!Array.isArray(value)) return undefined;
      return property(value[name === "left" ? 0 : 1], path);
    }
    return property(captures[name ?? ""], path);
  }
  return literal(source, program, range);
};

const parseProjection = (step: DslStep, program: DslProgram): readonly { readonly name: string; readonly expression: string }[] => {
  const open = step.source.indexOf("{");
  const close = step.source.lastIndexOf("}");
  if (open < 0 || close < open) return fail(program, "dsl.expected-projection", "Expected `project { name: expression }`.", step.range);
  const start = step.range.start + open + 1;
  return commaParts(program.source, start, step.range.start + close).map((entry) => {
    const colon = entry.text.indexOf(":");
    if (colon < 1) return fail(program, "dsl.invalid-projection", "Expected `name: expression`.", { start: entry.start, end: entry.end });
    return Object.freeze({ name: entry.text.slice(0, colon).trim(), expression: entry.text.slice(colon + 1).trim() });
  });
};

interface PipelineState {
  readonly query: Query<unknown, CaptureMap>;
  readonly adapter?: Adapter;
  readonly invocation?: {
    readonly step: DslStep;
    readonly adapter: Adapter;
    readonly create: (target: NavigableNodeHandle, args: Readonly<Record<string, Scalar>>) => Operation;
    readonly args: Readonly<Record<string, Scalar>>;
  };
  readonly terminalPlan?: boolean;
}

const selectorFailure = (error: SelectorError, program: DslProgram, offset: number): DslError =>
  new DslError(error.diagnostics.map((value) => defineDiagnostic({
    ...value,
    locations: value.locations.map((location) => location.kind === "program" && location.range !== undefined
      ? { ...location, uri: program.uri, range: { ...location.range, start: location.range.start + offset, end: location.range.end + offset } }
      : location),
  })));

const compare = (left: unknown, right: unknown): number => {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
  if (typeof left === "bigint" && typeof right === "bigint") return left < right ? -1 : 1;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : 1;
  return String(left).localeCompare(String(right));
};

const scalarType = (value: Scalar): "string" | "number" | "boolean" | "bigint" | "null" =>
  value === null
    ? "null"
    : typeof value === "string"
      ? "string"
      : typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : "bigint";

const validateWhereType = (
  condition: RegExpExecArray,
  adapter: Adapter | undefined,
  program: DslProgram,
  step: DslStep,
): void => {
  if (adapter === undefined) return;
  const left = condition[1]?.trim() ?? "";
  const right = condition[3]?.trim() ?? "";
  if (!/^@[A-Za-z][A-Za-z0-9_-]*$/u.test(left) || right.startsWith("@") || right.startsWith("$")) return;
  const attribute = left.slice(1);
  const definitions = adapter.schema.kinds.flatMap(({ attributes }) => attributes[attribute] ?? []);
  if (definitions.length === 0) return fail(program, "dsl.unknown-attribute", `Unknown attribute ${JSON.stringify(attribute)}.`, step.range);
  const value = literal(right, program, step.range);
  const type = scalarType(value);
  if (!definitions.some(({ scalar }) => (Array.isArray(scalar) ? scalar : [scalar]).includes(type))) {
    return fail(program, "dsl.type-mismatch", `Attribute ${JSON.stringify(attribute)} cannot be compared with ${type}.`, step.range);
  }
};

const compilePipeline = (
  pipeline: DslPipeline,
  program: DslProgram,
  environment: DslEnvironment,
  bindings: ReadonlyMap<string, PipelineState>,
): PipelineState => {
  const from = parseFrom(pipeline.source, program);
  const source = environment.sources[from.name];
  if (source === undefined) return fail(program, "dsl.unknown-source", `Unknown source ${JSON.stringify(from.name)}.`, pipeline.source.range);
  let state: PipelineState = {
    query: source.open(from.args) as Query<unknown, CaptureMap>,
    adapter: source.adapter,
  };
  for (const step of pipeline.steps) {
    if (state.terminalPlan === true) return fail(program, "dsl.after-plan", "No pipeline step may follow `plan`.", step.range);
    if (state.invocation !== undefined && step.kind !== "plan") return fail(program, "dsl.expected-plan", "`invoke` must be followed immediately by `plan`.", step.range);
    if (step.kind === "mount") {
      const name = /^mount\s+([A-Za-z][A-Za-z0-9_-]*)$/u.exec(step.source)?.[1];
      const mount = name === undefined ? undefined : environment.mounts?.[name];
      if (mount === undefined) return fail(program, "dsl.unsupported-mount", `Unknown or unsupported mount ${JSON.stringify(name)}.`, step.range);
      state = { query: mount.mount(state.query as Query<NavigableNodeHandle, CaptureMap>) as Query<unknown, CaptureMap>, adapter: mount.adapter };
      continue;
    }
    if (step.kind === "select") {
      if (state.adapter === undefined) return fail(program, "dsl.select-after-derived", "Selection requires an adapter-backed node query.", step.range);
      const quoted = step.source.slice("select".length).trim();
      const selector = unquote(quoted, program, step.range);
      const quoteOffset = step.range.start + step.source.indexOf(quoted) + 1;
      try {
        state = { query: selectFrom(state.query as Query<NavigableNodeHandle, CaptureMap>, state.adapter.schema, selector, { uri: program.uri }) as Query<unknown, CaptureMap>, adapter: state.adapter };
      } catch (error) {
        if (error instanceof SelectorError) throw selectorFailure(error, program, quoteOffset);
        throw error;
      }
      continue;
    }
    if (step.kind === "where") {
      const condition = step.source.slice("where".length).trim();
      const nullMatch = /^(.*?)\s+is\s+(null|missing)$/u.exec(condition);
      const comparison = /^(.*?)\s*(=|!=|<=|>=|<|>|\^=|\$=|\*=)\s*(.*?)$/u.exec(condition);
      if (nullMatch === null && comparison === null) return fail(program, "dsl.invalid-where", "Expected a comparison or `is null`/`is missing`.", step.range);
      if (comparison !== null) validateWhereType(comparison, state.adapter, program, step);
      state = {
        ...state,
        query: state.query.filter((value, captures) => {
          if (nullMatch !== null) {
            const selected = expressionValue(nullMatch[1] ?? "", value, captures, program, step.range);
            return nullMatch[2] === "null" ? selected === null : selected === undefined;
          }
          const left = expressionValue(comparison?.[1] ?? "", value, captures, program, step.range);
          const right = expressionValue(comparison?.[3] ?? "", value, captures, program, step.range);
          const operator = comparison?.[2];
          if (operator === "=") return typeof left === typeof right && left === right;
          if (operator === "!=") return typeof left !== typeof right || left !== right;
          if (operator === "^=") return typeof left === "string" && typeof right === "string" && left.startsWith(right);
          if (operator === "$=") return typeof left === "string" && typeof right === "string" && left.endsWith(right);
          if (operator === "*=") return typeof left === "string" && typeof right === "string" && left.includes(right);
          const order = compare(left, right);
          if (operator === "<") return order < 0;
          if (operator === "<=") return order <= 0;
          if (operator === ">") return order > 0;
          return order >= 0;
        }, "dsl where"),
      };
      continue;
    }
    if (step.kind === "project") {
      const fields = parseProjection(step, program);
      state = {
        query: state.query.project((value, captures) => Object.fromEntries(fields.map(({ name, expression }) => [name, expressionValue(expression, value, captures, program, step.range)])), "dsl project") as Query<unknown, CaptureMap>,
      };
      continue;
    }
    if (step.kind === "distinct") {
      if (step.source !== "distinct") return fail(program, "dsl.invalid-distinct", "`distinct` takes no arguments.", step.range);
      state = { ...state, query: state.query.distinct() };
      continue;
    }
    if (step.kind === "take") {
      const count = Number(/^take\s+([0-9]+)$/u.exec(step.source)?.[1]);
      if (!Number.isSafeInteger(count)) return fail(program, "dsl.invalid-take", "Expected `take` with a non-negative integer.", step.range);
      state = { ...state, query: state.query.take(count) };
      continue;
    }
    if (step.kind === "count") {
      if (step.source !== "count") return fail(program, "dsl.invalid-count", "`count` takes no arguments.", step.range);
      state = { query: state.query.count() as Query<unknown, CaptureMap> };
      continue;
    }
    if (step.kind === "sort") {
      const names = step.source.slice("sort".length).split(",").map((name) => name.trim()).filter(Boolean);
      if (names.length === 0) return fail(program, "dsl.invalid-sort", "Expected one or more projected sort fields.", step.range);
      state = { query: state.query.sort((left, right) => {
        for (const name of names) {
          const result = compare(property(left, [name]), property(right, [name]));
          if (result !== 0) return result;
        }
        return 0;
      }, "dsl sort") as Query<unknown, CaptureMap> };
      continue;
    }
    if (step.kind === "join") {
      const match = /^join\s+([A-Za-z][A-Za-z0-9_-]*)\s+on\s+(.+?)\s*=\s*(.+)$/u.exec(step.source);
      if (match === null) return fail(program, "dsl.invalid-join", "Expected `join binding on expression = expression`.", step.range);
      const right = bindings.get(match[1] ?? "");
      if (right === undefined || right.invocation !== undefined) return fail(program, "dsl.unknown-binding", `Unknown query binding ${JSON.stringify(match[1])}.`, step.range);
      state = {
        query: state.query.join(right.query, {
          leftKey: (value) => expressionValue(match[2] ?? "", value, {}, program, step.range),
          rightKey: (value) => expressionValue(match[3] ?? "", value, {}, program, step.range),
          label: "dsl join",
        }) as Query<unknown, CaptureMap>,
      };
      continue;
    }
    if (step.kind === "invoke") {
      const name = /^invoke\s+([^\s{]+)/u.exec(step.source)?.[1];
      const operation = name === undefined ? undefined : environment.operations?.[name];
      if (operation === undefined) return fail(program, "dsl.unsupported-operation", `Unknown or unsupported operation ${JSON.stringify(name)}.`, step.range);
      if (operation.adapter.planning === undefined) return fail(program, "dsl.missing-planning", `Adapter ${operation.adapter.namespace} cannot plan operations.`, step.range);
      state = { ...state, invocation: { step, adapter: operation.adapter, create: operation.create, args: parseObject(step, "invoke", program) } };
      continue;
    }
    if (step.kind === "plan") {
      if (step.source !== "plan" || state.invocation === undefined) return fail(program, "dsl.invalid-plan", "`plan` requires a preceding `invoke`.", step.range);
      state = { ...state, terminalPlan: true };
      continue;
    }
    return fail(program, "dsl.unknown-step", `Unknown pipeline step ${JSON.stringify(step.kind)}.`, step.range);
  }
  return state;
};

export const compileDsl = (
  source: string | DslProgram,
  environment: DslEnvironment,
  options: DslOptions = {},
): CompiledDsl => {
  const program = typeof source === "string" ? parseDsl(source, options) : source;
  const bindings = new Map<string, PipelineState>();
  for (const binding of program.bindings) {
    if (bindings.has(binding.name)) return fail(program, "dsl.duplicate-binding", `Duplicate binding ${binding.name}.`, binding.range);
    const compiled = compilePipeline(binding.pipeline, program, environment, bindings);
    if (compiled.invocation !== undefined || compiled.terminalPlan === true) return fail(program, "dsl.effectful-binding", "Bindings may contain queries only.", binding.range);
    bindings.set(binding.name, compiled);
  }
  const compiled = compilePipeline(program.pipeline, program, environment, bindings);
  if (compiled.invocation === undefined) {
    if (compiled.terminalPlan === true) return fail(program, "dsl.invalid-plan", "Plan has no invocation.", program.pipeline.range);
    return Object.freeze({ kind: "query", query: compiled.query, program });
  }
  if (compiled.terminalPlan !== true) return fail(program, "dsl.expected-plan", "Transformation pipelines must end with `plan`.", compiled.invocation.step.range);
  return Object.freeze({
    kind: "plan",
    program,
    async plan() {
      try {
        const values = await compiled.query.toArray();
        const operations = values.map((value, index) => {
          if (!isNode(value)) return fail(program, "dsl.operation-target", "Operation target is not a node.", compiled.invocation?.step.range ?? program.pipeline.range);
          return {
            id: `dsl:${index}`,
            adapter: compiled.invocation?.adapter ?? fail(program, "dsl.internal", "Missing invocation.", program.pipeline.range),
            operation: compiled.invocation?.create(value, compiled.invocation.args) ?? fail(program, "dsl.internal", "Missing invocation.", program.pipeline.range),
          };
        });
        const plan = await planOperations(operations);
        if (plan.diagnostics.length === 0) return plan;
        const programLocation = {
          kind: "program" as const,
          uri: program.uri,
          range: compiled.invocation?.step.range ?? program.pipeline.range,
        };
        return immutableCopy({
          ...plan,
          diagnostics: plan.diagnostics.map((value) => defineDiagnostic({
            ...value,
            locations: [programLocation, ...value.locations],
          })),
        });
      } catch (error) {
        if (error instanceof DslError) throw error;
        throw new DslError([diagnostic("dsl.planning-failed", error instanceof Error ? error.message : "Planning failed.", program.uri, compiled.invocation?.step.range ?? program.pipeline.range)]);
      }
    },
  });
};

const formatPipeline = (pipeline: DslPipeline): string =>
  [pipeline.source.source, ...pipeline.steps.map((step) => `| ${step.source}`)].join("\n");

export const formatDsl = (program: DslProgram): string => {
  const bindings = program.bindings.map((binding) => `let ${binding.name} = ${formatPipeline(binding.pipeline)};`).join("\n");
  return `${bindings.length === 0 ? "" : `${bindings}\n`}${formatPipeline(program.pipeline)}\n`;
};
