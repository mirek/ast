import type { Adapter, Operation } from "./adapter.js";
import { planOperations } from "./change.js";
import type { ChangePlan } from "./change.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import type { NamespacedName, Scalar, SourceRange } from "./model.js";
import { fromValues } from "./query.js";
import type { CaptureMap, ExecuteOptions, NavigableNodeHandle, Query } from "./query.js";
import type { AdapterSchema, Cardinality, ScalarType } from "./schema.js";
import { SelectorError, selectFrom } from "./selector.js";
import type { SelectorExtensionPredicate } from "./selector.js";
import type { SelectorSourceMode } from "./selector.js";

export interface DslOptions { readonly uri?: string; }
export type DslArgumentValue = Scalar | readonly Scalar[];
export interface DslArgumentDefinition {
  readonly type: ScalarType | readonly ScalarType[];
  readonly cardinality: Cardinality;
  readonly required: boolean;
  readonly default?: DslArgumentValue;
  readonly choices?: readonly Scalar[];
  readonly sensitive?: boolean;
}
export type DslArgumentSchema = Readonly<Record<string, DslArgumentDefinition>>;
export type DslArguments = Readonly<Record<string, DslArgumentValue>>;
export interface DslScalarFunction {
  readonly name: NamespacedName;
  readonly parameters: readonly ScalarType[];
  readonly returns: ScalarType;
  call(args: readonly Scalar[]): Scalar;
}
export interface DslEnvironment {
  readonly sources: Readonly<Record<string, {
    readonly adapter: Adapter;
    readonly selectorSource: SelectorSourceMode;
    readonly arguments: DslArgumentSchema;
    treeView?(args: DslArguments): NamespacedName | undefined;
    open(args: DslArguments): Query<NavigableNodeHandle>;
  }>>;
  readonly mounts?: Readonly<Record<string, {
    readonly adapter: Adapter;
    readonly arguments: DslArgumentSchema;
    treeView?(args: DslArguments): NamespacedName | undefined;
    mount(
      query: Query<NavigableNodeHandle, CaptureMap>,
      args: DslArguments,
    ): Query<NavigableNodeHandle, CaptureMap>;
  }>>;
  readonly operations?: Readonly<Record<string, {
    readonly adapter: Adapter;
    readonly arguments?: DslArgumentSchema;
    create(target: NavigableNodeHandle, args: DslArguments): Operation;
  }>>;
  readonly predicates?: Readonly<Record<string, SelectorExtensionPredicate>>;
  readonly functions?: Readonly<Record<string, DslScalarFunction>>;
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
  let brackets = 0;
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
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === separator && braces === 0 && parentheses === 0 && brackets === 0) {
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
  let brackets = 0;
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
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    if (braces < 0 || parentheses < 0 || brackets < 0) throw new DslError([diagnostic("dsl.unbalanced", "Unexpected closing delimiter.", uri, { start: index, end: index + 1 })]);
  }
  if (quote !== undefined) throw new DslError([diagnostic("dsl.unterminated-string", "Unterminated string literal.", uri, { start: quoteStart, end: source.length })]);
  if (braces !== 0 || parentheses !== 0 || brackets !== 0) throw new DslError([diagnostic("dsl.unbalanced", "Unclosed delimiter.", uri, { start: Math.max(0, source.length - 1), end: source.length })]);
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

const scalarKind = (value: Scalar): ScalarType =>
  value === null ? "null" : typeof value as Exclude<ScalarType, "null">;

const scalarTypes = new Set<ScalarType>([
  "string",
  "number",
  "boolean",
  "bigint",
  "null",
]);

const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  typeof value === "bigint";

const isSerializableSchemaScalar = (value: Scalar): boolean =>
  typeof value !== "bigint" && (typeof value !== "number" || Number.isFinite(value));

const allowedTypes = (definition: DslArgumentDefinition): readonly ScalarType[] =>
  typeof definition.type === "string" ? [definition.type] : definition.type;

const immutableArgumentValue = (value: DslArgumentValue): DslArgumentValue =>
  Array.isArray(value) ? Object.freeze([...value] as Scalar[]) : value;

const valueMatchesDefinition = (
  value: Scalar,
  definition: DslArgumentDefinition,
): boolean =>
  allowedTypes(definition).includes(scalarKind(value)) &&
  (definition.choices === undefined || definition.choices.some((choice) => choice === value));

export const defineDslArgumentSchema = <const T extends DslArgumentSchema>(value: T): T => {
  for (const [name, definition] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name)) {
      throw new TypeError(`Invalid DSL argument name ${JSON.stringify(name)}.`);
    }
    if (definition === null || typeof definition !== "object") {
      throw new TypeError(`DSL argument ${name} definition must be an object.`);
    }
    const types = typeof definition.type === "string"
      ? [definition.type]
      : Array.isArray(definition.type)
        ? definition.type
        : [];
    if (
      types.length === 0 ||
      types.some((type) => !scalarTypes.has(type)) ||
      new Set(types).size !== types.length
    ) {
      throw new TypeError(`DSL argument ${name} must declare unique scalar types.`);
    }
    if (definition.cardinality !== "one" && definition.cardinality !== "many") {
      throw new TypeError(`DSL argument ${name} must declare one or many cardinality.`);
    }
    if (typeof definition.required !== "boolean") {
      throw new TypeError(`DSL argument ${name} required flag must be boolean.`);
    }
    if (definition.sensitive !== undefined && typeof definition.sensitive !== "boolean") {
      throw new TypeError(`DSL argument ${name} sensitive flag must be boolean.`);
    }
    if (definition.required && definition.default !== undefined) {
      throw new TypeError(`Required DSL argument ${name} cannot declare a default.`);
    }
    const defaults = definition.default === undefined
      ? undefined
      : Array.isArray(definition.default)
        ? definition.default
        : [definition.default];
    if (defaults?.some((entry) => !isScalar(entry)) === true) {
      throw new TypeError(`DSL argument ${name} default must contain only scalar values.`);
    }
    if (
      defaults !== undefined &&
      (definition.cardinality === "many") !== Array.isArray(definition.default)
    ) {
      throw new TypeError(`DSL argument ${name} default has the wrong cardinality.`);
    }
    if (defaults?.some((entry) => !valueMatchesDefinition(entry, definition)) === true) {
      throw new TypeError(`DSL argument ${name} default does not match its type or choices.`);
    }
    if (defaults?.some((entry) => !isSerializableSchemaScalar(entry)) === true) {
      throw new TypeError(`DSL argument ${name} default must be JSON-serializable.`);
    }
    if (
      definition.choices !== undefined &&
      (!Array.isArray(definition.choices) || definition.choices.some((choice) => !isScalar(choice)))
    ) {
      throw new TypeError(`DSL argument ${name} choices must contain only scalar values.`);
    }
    if (
      definition.choices?.some((choice) => !allowedTypes(definition).includes(scalarKind(choice))) === true
    ) {
      throw new TypeError(`DSL argument ${name} choices do not match its type.`);
    }
    if (
      definition.choices?.some((choice) => !isSerializableSchemaScalar(choice)) === true
    ) {
      throw new TypeError(`DSL argument ${name} choices must be JSON-serializable.`);
    }
    if (
      definition.choices !== undefined &&
      new Set(definition.choices).size !== definition.choices.length
    ) {
      throw new TypeError(`DSL argument ${name} choices must be unique.`);
    }
  }
  return immutableCopy(value);
};

interface ParsedDslArguments {
  readonly values: DslArguments;
  readonly ranges: Readonly<Record<string, SourceRange>>;
}

const argumentValue = (
  value: string,
  program: DslProgram,
  range: SourceRange,
): DslArgumentValue => {
  const source = value.trim();
  if (!source.startsWith("[")) return literal(source, program, range);
  if (!source.endsWith("]")) {
    return fail(program, "dsl.invalid-arguments", "Expected a closed argument array.", range);
  }
  const offset = range.start + value.indexOf("[") + 1;
  const end = range.start + value.lastIndexOf("]");
  return Object.freeze(
    commaParts(program.source, offset, end).map((part) =>
      literal(part.text, program, { start: part.start, end: part.end })),
  );
};

const parseArguments = (
  source: string,
  range: SourceRange,
  program: DslProgram,
): ParsedDslArguments => {
  const segment = trimmed(program.source, range.start, range.end);
  if (segment.text.length === 0) {
    return { values: Object.freeze({}), ranges: Object.freeze({}) };
  }
  if (!segment.text.startsWith("{") || !segment.text.endsWith("}")) {
    return fail(
      program,
      "dsl.expected-arguments",
      "Expected one named argument object.",
      range,
    );
  }
  const values: Record<string, DslArgumentValue> = {};
  const ranges: Record<string, SourceRange> = {};
  for (const entry of commaParts(source, segment.start + 1, segment.end - 1)) {
    const colon = entry.text.indexOf(":");
    if (colon < 1) {
      return fail(
        program,
        "dsl.invalid-arguments",
        "Expected `name: value` in an argument object.",
        { start: entry.start, end: entry.end },
      );
    }
    const name = entry.text.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name)) {
      return fail(
        program,
        "dsl.invalid-name",
        "Invalid argument name.",
        { start: entry.start, end: entry.start + colon },
      );
    }
    if (values[name] !== undefined) {
      return fail(
        program,
        "dsl.duplicate-argument",
        `Argument ${JSON.stringify(name)} appears more than once.`,
        { start: entry.start, end: entry.end },
      );
    }
    const valueStart = entry.start + colon + 1;
    const valueRange = { start: valueStart, end: entry.end };
    values[name] = argumentValue(entry.text.slice(colon + 1), program, valueRange);
    ranges[name] = Object.freeze({ start: entry.start, end: entry.end });
  }
  return {
    values: Object.freeze(values),
    ranges: Object.freeze(ranges),
  };
};

const resolveArguments = (
  schema: DslArgumentSchema,
  parsed: ParsedDslArguments,
  program: DslProgram,
  range: SourceRange,
): DslArguments => {
  try {
    defineDslArgumentSchema(schema);
  } catch (error) {
    return fail(
      program,
      "dsl.invalid-argument-schema",
      error instanceof Error ? error.message : "Invalid DSL argument schema.",
      range,
    );
  }
  for (const name of Object.keys(parsed.values)) {
    if (schema[name] === undefined) {
      return fail(
        program,
        "dsl.unknown-argument",
        `Unknown argument ${JSON.stringify(name)}.`,
        parsed.ranges[name] ?? range,
      );
    }
  }
  const result: Record<string, DslArgumentValue> = {};
  for (const [name, definition] of Object.entries(schema)) {
    const value = parsed.values[name];
    if (value === undefined) {
      if (definition.default !== undefined) {
        result[name] = immutableArgumentValue(definition.default);
      }
      else if (definition.required) {
        return fail(
          program,
          "dsl.missing-argument",
          `Missing required argument ${JSON.stringify(name)}.`,
          range,
        );
      }
      continue;
    }
    const many = Array.isArray(value);
    if ((definition.cardinality === "many") !== many) {
      return fail(
        program,
        "dsl.argument-cardinality",
        `Argument ${JSON.stringify(name)} must have ${definition.cardinality} cardinality.`,
        parsed.ranges[name] ?? range,
      );
    }
    const entries = many ? value : [value];
    const typeMismatch = entries.some((entry) =>
      !allowedTypes(definition).includes(scalarKind(entry)));
    if (typeMismatch) {
      return fail(
        program,
        "dsl.argument-type",
        `Argument ${JSON.stringify(name)} has the wrong scalar type.`,
        parsed.ranges[name] ?? range,
      );
    }
    if (
      definition.choices !== undefined &&
      entries.some((entry) => !definition.choices?.some((choice) => choice === entry))
    ) {
      return fail(
        program,
        "dsl.argument-choice",
        `Argument ${JSON.stringify(name)} is not one of its allowed choices.`,
        parsed.ranges[name] ?? range,
      );
    }
    result[name] = value;
  }
  return immutableCopy(result);
};

const parseFrom = (
  step: DslStep,
  program: DslProgram,
): { readonly name: string; readonly args: ParsedDslArguments } => {
  const match = /^from\s+([A-Za-z][A-Za-z0-9_-]*)\s*\((.*)\)$/us.exec(step.source);
  if (match === null) return fail(program, "dsl.invalid-source", "Expected `from source(arguments)`.", step.range);
  const argsSource = match[2] ?? "";
  const argsOffset = step.range.start + step.source.indexOf(argsSource);
  const args = parseArguments(
    program.source,
    { start: argsOffset, end: argsOffset + argsSource.length },
    program,
  );
  return { name: match[1] ?? "", args };
};

const parseMount = (
  step: DslStep,
  program: DslProgram,
): { readonly name: string; readonly args: ParsedDslArguments } => {
  const match = /^mount\s+([A-Za-z][A-Za-z0-9_-]*)\s*\((.*)\)$/us.exec(step.source);
  if (match === null) {
    return fail(
      program,
      "dsl.invalid-mount",
      "Expected `mount name(arguments)`.",
      step.range,
    );
  }
  const argsSource = match[2] ?? "";
  const argsOffset = step.range.start + step.source.indexOf(argsSource);
  return {
    name: match[1] ?? "",
    args: parseArguments(
      program.source,
      { start: argsOffset, end: argsOffset + argsSource.length },
      program,
    ),
  };
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

const parseObjectArguments = (step: DslStep, keyword: string, program: DslProgram): ParsedDslArguments => {
  const prefix = new RegExp(`^${keyword}\\s+[^\\s{]+\\s*`, "u").exec(step.source)?.[0] ?? `${keyword} `;
  const open = step.source.indexOf("{", Math.min(prefix.length, step.source.length));
  const close = step.source.lastIndexOf("}");
  if (open < 0 || close < open) return fail(program, "dsl.expected-object", `Expected an argument object after ${keyword}.`, step.range);
  const start = step.range.start + open;
  return parseArguments(program.source, { start, end: step.range.start + close + 1 }, program);
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

const expressionValue = (
  expression: string,
  value: unknown,
  captures: CaptureMap,
  program: DslProgram,
  range: SourceRange,
  functions: Readonly<Record<string, DslScalarFunction>> = {},
): unknown => {
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
  const call = /^([A-Za-z][A-Za-z0-9_-]*(?:::[A-Za-z][A-Za-z0-9_-]*)?)\((.*)\)$/us.exec(source);
  if (call !== null) {
    const extension = functions[call[1] ?? ""];
    if (extension === undefined) return fail(program, "dsl.unknown-function", `Unknown scalar function ${JSON.stringify(call[1])}.`, range);
    const body = call[2] ?? "";
    const args = body.trim().length === 0
      ? []
      : splitTopLevel(body, 0, body.length, ",").map((part) =>
          expressionValue(part.text, value, captures, program, range, functions));
    if (
      args.length !== extension.parameters.length ||
      args.some((entry, index) => !isScalar(entry) || scalarKind(entry) !== extension.parameters[index])
    ) return fail(program, "dsl.function-arguments", `Scalar function ${extension.name} received ill-typed arguments.`, range);
    try {
      const result: unknown = extension.call(args as Scalar[]);
      if (result instanceof Promise) throw new TypeError("Scalar functions must be synchronous.");
      if (!isScalar(result) || scalarKind(result) !== extension.returns) throw new TypeError(`Scalar function must return ${extension.returns}.`);
      return result;
    } catch (error) {
      return fail(program, "plugin.query-extension-failed", `Scalar function ${extension.name} failed: ${error instanceof Error ? error.message : "unknown failure"}`, range);
    }
  }
  return literal(source, program, range);
};

interface ProjectionExpressionContext {
  readonly program: DslProgram;
  readonly range: SourceRange;
  readonly selectorSchemas?: readonly AdapterSchema[];
  readonly treeView?: NamespacedName;
  readonly predicates?: Readonly<Record<string, SelectorExtensionPredicate>>;
  readonly functions?: Readonly<Record<string, DslScalarFunction>>;
}

interface CompiledProjectionExpression {
  readonly labels: readonly string[];
  evaluate(
    value: unknown,
    captures: CaptureMap,
    options: ExecuteOptions,
  ): Promise<unknown>;
}

const compileProjectionExpression = (
  expression: string,
  context: ProjectionExpressionContext,
): CompiledProjectionExpression => {
  const source = expression.trim();
  if (source.startsWith("{") && source.endsWith("}")) {
    const fields = commaParts(source, 1, source.length - 1).map((entry) => {
      const colon = entry.text.indexOf(":");
      if (colon < 1) return fail(context.program, "dsl.invalid-record", "Expected `name: expression` in a projected record.", context.range);
      const name = entry.text.slice(0, colon).trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name)) return fail(context.program, "dsl.invalid-record", `Invalid projected record field ${JSON.stringify(name)}.`, context.range);
      return { name, compiled: compileProjectionExpression(entry.text.slice(colon + 1), context) };
    });
    const names = new Set<string>();
    for (const { name } of fields) {
      if (names.has(name)) return fail(context.program, "dsl.duplicate-field", `Duplicate projected record field ${JSON.stringify(name)}.`, context.range);
      names.add(name);
    }
    return {
      labels: Object.freeze(fields.flatMap(({ compiled }) => compiled.labels)),
      async evaluate(value, captures, options) {
        const result: Record<string, unknown> = {};
        for (const field of fields) {
          // Sequential evaluation preserves deterministic graph-read ordering.
          // oxlint-disable-next-line no-await-in-loop
          result[field.name] = await field.compiled.evaluate(value, captures, options);
        }
        return Object.freeze(result);
      },
    };
  }

  const related = /^related\s*\((.*)\)$/us.exec(source);
  if (related !== null) {
    const args = splitTopLevel(related[1] ?? "", 0, (related[1] ?? "").length, ",");
    if (args.length !== 3) return fail(context.program, "dsl.related-arguments", "`related` requires a mode, selector, and projection expression.", context.range);
    const mode = literal(args[0]?.text ?? "", context.program, context.range);
    const selector = literal(args[1]?.text ?? "", context.program, context.range);
    if (mode !== "one" && mode !== "many") return fail(context.program, "dsl.related-mode", "Related projection mode must be one or many.", context.range);
    if (typeof selector !== "string") return fail(context.program, "dsl.related-selector", "Related projection requires a quoted selector.", context.range);
    const selectorSchemas = context.selectorSchemas;
    if (selectorSchemas === undefined) return fail(context.program, "dsl.related-after-derived", "Related projection requires an adapter-backed node query.", context.range);
    const selectorOptions = {
      ...(context.treeView === undefined ? {} : { treeView: context.treeView }),
      ...(context.predicates === undefined ? {} : { predicates: context.predicates }),
    };
    try {
      selectFrom(fromValues<NavigableNodeHandle>([]), selectorSchemas, selector, selectorOptions);
    } catch (error) {
      if (error instanceof SelectorError) throw selectorFailure(error, context.program, context.range.start);
      throw error;
    }
    const projected = compileProjectionExpression(args[2]?.text ?? "", context);
    return {
      labels: Object.freeze([`related ${mode}`, ...projected.labels]),
      async evaluate(value, captures, options) {
        if (!isNode(value)) return fail(context.program, "dsl.related-node", "Related projection requires a graph node.", context.range);
        const selected = selectFrom(fromValues([value]), selectorSchemas, selector, selectorOptions)
          .project(async (relatedValue, relatedCaptures, relatedOptions) => {
            const collisions = Object.keys(relatedCaptures).filter((name) => name in captures);
            if (collisions.length > 0) return fail(context.program, "dsl.related-capture-collision", `Related selector capture $${collisions[0]} collides with an outer capture.`, context.range);
            return projected.evaluate(
              relatedValue,
              Object.freeze({ ...captures, ...relatedCaptures }),
              relatedOptions,
            );
          }, `related ${mode}`);
        const values: unknown[] = [];
        for await (const selectedValue of selected.iterate(options)) {
          values.push(selectedValue);
          if (mode === "one" && values.length > 1) {
            return fail(context.program, "dsl.related-cardinality", "Related projection in one mode matched more than one node.", context.range);
          }
        }
        return mode === "one" ? values[0] : Object.freeze(values);
      },
    };
  }

  const called = /^\s*([A-Za-z][A-Za-z0-9_-]*(?:::[A-Za-z][A-Za-z0-9_-]*)?)\(/u.exec(source)?.[1];
  const canonical = called === undefined ? undefined : context.functions?.[called]?.name;
  return {
    labels: canonical === undefined ? Object.freeze([]) : Object.freeze([`plugin ${canonical}`]),
    async evaluate(value, captures) {
      return expressionValue(source, value, captures, context.program, context.range, context.functions);
    },
  };
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
  readonly selectorSchemas?: readonly AdapterSchema[];
  readonly selectorSource?: SelectorSourceMode;
  readonly treeView?: NamespacedName;
  readonly invocation?: {
    readonly step: DslStep;
    readonly adapter: Adapter;
    readonly create: (target: NavigableNodeHandle, args: DslArguments) => Operation;
    readonly args: DslArguments;
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

const resolveTreeView = (
  adapter: Adapter,
  selected: NamespacedName | undefined,
  program: DslProgram,
  range: SourceRange,
): NamespacedName | undefined => {
  if (selected === undefined) return undefined;
  if (!adapter.schema.treeViews.some(({ name }) => name === selected)) {
    const namespace = selected.slice(0, selected.indexOf("::"));
    return fail(
      program,
      namespace === adapter.namespace ? "dsl.unknown-tree-view" : "dsl.incompatible-tree-view",
      `Tree view ${JSON.stringify(selected)} is not available from adapter ${adapter.namespace}.`,
      range,
    );
  }
  return selected;
};

const compare = (left: unknown, right: unknown): number => {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1;
  if (typeof left === "bigint" && typeof right === "bigint") return left < right ? -1 : 1;
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : 1;
  return String(left).localeCompare(String(right));
};

const validateWhereType = (
  condition: RegExpExecArray,
  adapter: Adapter | undefined,
  program: DslProgram,
  step: DslStep,
): void => {
  if (adapter === undefined) return;
  const left = condition[1]?.trim() ?? "";
  const right = condition[3]?.trim() ?? "";
  if (!/^@[A-Za-z][A-Za-z0-9_-]*$/u.test(left) || right.startsWith("@") || right.startsWith("$") || right.includes("(")) return;
  const attribute = left.slice(1);
  const definitions = adapter.schema.kinds.flatMap(({ attributes }) => attributes[attribute] ?? []);
  if (definitions.length === 0) return fail(program, "dsl.unknown-attribute", `Unknown attribute ${JSON.stringify(attribute)}.`, step.range);
  const value = literal(right, program, step.range);
  const type = scalarKind(value);
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
  const sourceArguments = resolveArguments(
    source.arguments,
    from.args,
    program,
    pipeline.source.range,
  );
  const sourceTreeView = resolveTreeView(
    source.adapter,
    source.treeView?.(sourceArguments),
    program,
    pipeline.source.range,
  );
  let state: PipelineState = {
    query: source.open(sourceArguments) as Query<unknown, CaptureMap>,
    adapter: source.adapter,
    selectorSchemas: Object.freeze([source.adapter.schema]),
    selectorSource: source.selectorSource,
    ...(sourceTreeView === undefined ? {} : { treeView: sourceTreeView }),
  };
  for (const step of pipeline.steps) {
    if (state.terminalPlan === true) return fail(program, "dsl.after-plan", "No pipeline step may follow `plan`.", step.range);
    if (state.invocation !== undefined && step.kind !== "plan") return fail(program, "dsl.expected-plan", "`invoke` must be followed immediately by `plan`.", step.range);
    if (step.kind === "mount") {
      const parsed = parseMount(step, program);
      const mount = environment.mounts?.[parsed.name];
      if (mount === undefined) return fail(program, "dsl.unsupported-mount", `Unknown or unsupported mount ${JSON.stringify(parsed.name)}.`, step.range);
      const mountArguments = resolveArguments(
        mount.arguments,
        parsed.args,
        program,
        step.range,
      );
      const mountTreeView = resolveTreeView(
        mount.adapter,
        mount.treeView?.(mountArguments),
        program,
        step.range,
      );
      state = {
        query: mount.mount(
          state.query as Query<NavigableNodeHandle, CaptureMap>,
          mountArguments,
        ) as Query<unknown, CaptureMap>,
        adapter: mount.adapter,
        selectorSchemas: Object.freeze([...(state.selectorSchemas ?? []), mount.adapter.schema]),
        selectorSource: "roots",
        ...(mountTreeView === undefined ? {} : { treeView: mountTreeView }),
      };
      continue;
    }
    if (step.kind === "select") {
      if (state.adapter === undefined) return fail(program, "dsl.select-after-derived", "Selection requires an adapter-backed node query.", step.range);
      const quoted = step.source.slice("select".length).trim();
      const selector = unquote(quoted, program, step.range);
      const quoteOffset = step.range.start + step.source.indexOf(quoted) + 1;
      try {
        state = {
          query: selectFrom(
            state.query as Query<NavigableNodeHandle, CaptureMap>,
            state.selectorSchemas ?? [state.adapter.schema],
            selector,
            {
              uri: program.uri,
              sourceMode: state.selectorSource ?? "roots",
              ...(state.treeView === undefined ? {} : { treeView: state.treeView }),
              ...(environment.predicates === undefined ? {} : { predicates: environment.predicates }),
            },
          ) as Query<unknown, CaptureMap>,
          adapter: state.adapter,
          ...(state.selectorSchemas === undefined ? {} : { selectorSchemas: state.selectorSchemas }),
          selectorSource: "roots",
          ...(state.treeView === undefined ? {} : { treeView: state.treeView }),
        };
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
            const selected = expressionValue(nullMatch[1] ?? "", value, captures, program, step.range, environment.functions);
            return nullMatch[2] === "null" ? selected === null : selected === undefined;
          }
          const left = expressionValue(comparison?.[1] ?? "", value, captures, program, step.range, environment.functions);
          const right = expressionValue(comparison?.[3] ?? "", value, captures, program, step.range, environment.functions);
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
      const compiled = fields.map(({ name, expression }) => ({
        name,
        expression: compileProjectionExpression(expression, {
          program,
          range: step.range,
          ...(state.selectorSchemas === undefined ? {} : { selectorSchemas: state.selectorSchemas }),
          ...(state.treeView === undefined ? {} : { treeView: state.treeView }),
          ...(environment.predicates === undefined ? {} : { predicates: environment.predicates }),
          ...(environment.functions === undefined ? {} : { functions: environment.functions }),
        }),
      }));
      state = {
        query: state.query.project(
          async (value, captures, options) => {
            const result: Record<string, unknown> = {};
            for (const field of compiled) {
              // Sequential evaluation preserves projection field ordering and graph reads.
              // oxlint-disable-next-line no-await-in-loop
              result[field.name] = await field.expression.evaluate(value, captures, options);
            }
            return result;
          },
          ["dsl project", ...compiled.flatMap(({ expression }) => expression.labels)].join("; "),
        ) as Query<unknown, CaptureMap>,
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
          leftKey: (value) => expressionValue(match[2] ?? "", value, {}, program, step.range, environment.functions),
          rightKey: (value) => expressionValue(match[3] ?? "", value, {}, program, step.range, environment.functions),
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
      const args = operation.arguments === undefined
        ? parseObject(step, "invoke", program)
        : resolveArguments(operation.arguments, parseObjectArguments(step, "invoke", program), program, step.range);
      state = { ...state, invocation: { step, adapter: operation.adapter, create: operation.create, args } };
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
