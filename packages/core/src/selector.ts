import type { Adapter, SourceDescriptor } from "./adapter.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import type {
  AttributeValue,
  Edge,
  EdgeName,
  NamespacedName,
  NodeHandle,
  Scalar,
  SourceRange,
} from "./model.js";
import {
  fromAdapter,
  fromValues,
  type CaptureMap,
  type ExecuteOptions,
  type NavigableNodeHandle,
  Query,
} from "./query.js";
import type { AdapterSchema, AttributeSchema, NodeKindSchema, ScalarType } from "./schema.js";

export type SelectorSourceMode = "roots" | "selection";

export interface SelectorOptions {
  readonly uri?: string;
  readonly treeView?: NamespacedName;
  readonly sourceMode?: SelectorSourceMode;
}

export type SelectorCombinator =
  | { readonly kind: "child"; readonly range: SourceRange }
  | { readonly kind: "descendant"; readonly range: SourceRange }
  | { readonly kind: "adjacent-sibling"; readonly range: SourceRange }
  | { readonly kind: "following-sibling"; readonly range: SourceRange }
  | {
      readonly kind: "edge";
      readonly direction: "forward" | "reverse";
      readonly name: string;
      readonly range: SourceRange;
    };

export interface SelectorLiteral {
  readonly kind: "literal";
  readonly value: Scalar;
  readonly range: SourceRange;
}

export interface SelectorCaptureReference {
  readonly kind: "capture-reference";
  readonly capture: string;
  readonly attribute: string;
  readonly range: SourceRange;
}

export interface SelectorRegularExpression {
  readonly kind: "regular-expression";
  readonly pattern: string;
  readonly flags: string;
  readonly range: SourceRange;
}

export type SelectorOperand =
  | SelectorLiteral
  | SelectorCaptureReference
  | SelectorRegularExpression;

export type SelectorAttributePredicate =
  | {
      readonly kind: "exists";
      readonly attribute: string;
      readonly range: SourceRange;
    }
  | {
      readonly kind: "null" | "missing";
      readonly attribute: string;
      readonly range: SourceRange;
    }
  | {
      readonly kind: "comparison";
      readonly attribute: string;
      readonly operator: "=" | "!=" | "<" | "<=" | ">" | ">=" | "^=" | "$=" | "*=";
      readonly operand: SelectorLiteral | SelectorCaptureReference;
      readonly range: SourceRange;
    }
  | {
      readonly kind: "membership";
      readonly attribute: string;
      readonly operands: readonly SelectorLiteral[];
      readonly range: SourceRange;
    }
  | {
      readonly kind: "regex";
      readonly attribute: string;
      readonly operand: SelectorRegularExpression;
      readonly range: SourceRange;
    };

export interface SelectorPseudo {
  readonly kind: "not" | "is" | "has";
  readonly selectors: readonly SelectorSequence[];
  readonly range: SourceRange;
}

export interface SelectorCompound {
  readonly kind?: string;
  readonly attributes: readonly SelectorAttributePredicate[];
  readonly pseudos: readonly SelectorPseudo[];
  readonly captures: readonly { readonly name: string; readonly range: SourceRange }[];
  readonly range: SourceRange;
}

export interface SelectorStep {
  readonly combinator?: SelectorCombinator;
  readonly compound: SelectorCompound;
  readonly range: SourceRange;
}

export interface SelectorSequence {
  readonly leading?: SelectorCombinator;
  readonly steps: readonly SelectorStep[];
  readonly range: SourceRange;
}

export interface SelectorProgram {
  readonly source: string;
  readonly uri: string;
  readonly selectors: readonly SelectorSequence[];
  readonly range: SourceRange;
}

export class SelectorError extends SyntaxError {
  override readonly name = "SelectorError";
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(({ message }) => message).join("\n"));
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

const isNameStart = (value: string | undefined): boolean =>
  value !== undefined && /[A-Za-z]/u.test(value);

const isNamePart = (value: string | undefined): boolean =>
  value !== undefined && /[A-Za-z0-9._-]/u.test(value);

class Parser {
  readonly #source: string;
  readonly #uri: string;
  #index = 0;

  constructor(source: string, uri: string) {
    this.#source = source;
    this.#uri = uri;
  }

  parse(): SelectorProgram {
    this.#skipWhitespace();
    const selectors = this.#parseSelectorList(false);
    this.#skipWhitespace();
    if (!this.#atEnd()) this.#fail("selector.syntax", "Unexpected selector input.");
    if (selectors.length === 0) this.#fail("selector.syntax", "A selector must not be empty.", 0);
    if (selectors.length > 1) {
      this.#fail(
        "selector.syntax",
        "Top-level selector lists are not supported; use :is(...) explicitly.",
        selectors[1]?.range.start ?? 0,
      );
    }
    return immutableCopy({
      source: this.#source,
      uri: this.#uri,
      selectors,
      range: { start: 0, end: this.#source.length },
    });
  }

  #parseSelectorList(relative: boolean): SelectorSequence[] {
    const selectors: SelectorSequence[] = [];
    while (!this.#atEnd() && this.#peek() !== ")") {
      selectors.push(this.#parseSequence(relative));
      this.#skipWhitespace();
      if (this.#peek() !== ",") break;
      this.#index += 1;
      this.#skipWhitespace();
    }
    return selectors;
  }

  #parseSequence(relative: boolean): SelectorSequence {
    const start = this.#index;
    let leading: SelectorCombinator | undefined;
    if (relative && this.#startsCombinator()) {
      leading = this.#parseCombinator();
      this.#skipWhitespace();
    }
    const first = this.#parseCompound();
    const steps: SelectorStep[] = [{ compound: first, range: first.range }];

    while (true) {
      const whitespaceStart = this.#index;
      const hadWhitespace = this.#skipWhitespace();
      if (this.#atEnd() || this.#peek() === ")" || this.#peek() === ",") break;

      let combinator: SelectorCombinator;
      if (this.#startsCombinator()) {
        combinator = this.#parseCombinator();
        this.#skipWhitespace();
      } else if (hadWhitespace) {
        combinator = {
          kind: "descendant",
          range: { start: whitespaceStart, end: this.#index },
        };
      } else {
        this.#fail("selector.syntax", "Expected a selector combinator.");
      }

      const compound = this.#parseCompound();
      steps.push({ combinator, compound, range: { start: combinator.range.start, end: compound.range.end } });
    }

    return {
      ...(leading === undefined ? {} : { leading }),
      steps,
      range: { start, end: steps.at(-1)?.compound.range.end ?? start },
    };
  }

  #parseCompound(): SelectorCompound {
    const start = this.#index;
    let kind: string | undefined;
    if (isNameStart(this.#peek())) kind = this.#parseQualifiedName();

    const attributes: SelectorAttributePredicate[] = [];
    const pseudos: SelectorPseudo[] = [];
    while (true) {
      if (this.#peek() === "[") attributes.push(this.#parseAttribute());
      else if (this.#peek() === ":") pseudos.push(this.#parsePseudo());
      else break;
    }

    if (kind === undefined && attributes.length === 0 && pseudos.length === 0) {
      this.#fail("selector.syntax", "Expected a kind or predicate.", start);
    }

    const captures: { name: string; range: SourceRange }[] = [];
    while (true) {
      const beforeWhitespace = this.#index;
      if (!this.#skipWhitespace() || !this.#startsKeyword("as")) {
        this.#index = beforeWhitespace;
        break;
      }
      const captureStart = this.#index;
      this.#index += 2;
      if (!this.#skipWhitespace() || this.#peek() !== "$") {
        this.#fail("selector.syntax", "Expected a capture such as `as $name`.", captureStart);
      }
      this.#index += 1;
      const name = this.#parseIdentifier();
      captures.push({ name, range: { start: captureStart, end: this.#index } });
    }

    return {
      ...(kind === undefined ? {} : { kind }),
      attributes,
      pseudos,
      captures,
      range: { start, end: this.#index },
    };
  }

  #parseAttribute(): SelectorAttributePredicate {
    const start = this.#index;
    this.#index += 1;
    this.#skipWhitespace();
    const attribute = this.#parseSimpleName();
    this.#skipWhitespace();
    if (this.#peek() === "]") {
      this.#index += 1;
      return { kind: "exists", attribute, range: { start, end: this.#index } };
    }

    if (this.#startsKeyword("is")) {
      this.#index += 2;
      if (!this.#skipWhitespace()) this.#fail("selector.syntax", "Expected `null` or `missing` after `is`.");
      const predicate = this.#parseSimpleName();
      if (predicate !== "null" && predicate !== "missing") {
        this.#fail("selector.syntax", "Expected `null` or `missing` after `is`.", start);
      }
      this.#finishAttribute();
      return { kind: predicate, attribute, range: { start, end: this.#index } };
    }

    if (this.#startsKeyword("in")) {
      this.#index += 2;
      this.#skipWhitespace();
      this.#expect("(", "Expected `(` after `in`.");
      const operands: SelectorLiteral[] = [];
      while (true) {
        this.#skipWhitespace();
        operands.push(this.#parseLiteral());
        this.#skipWhitespace();
        if (this.#peek() !== ",") break;
        this.#index += 1;
      }
      this.#expect(")", "Expected `)` after membership values.");
      this.#finishAttribute();
      return { kind: "membership", attribute, operands, range: { start, end: this.#index } };
    }

    const operator = this.#parseOperator();
    this.#skipWhitespace();
    if (operator === "~=") {
      const operand = this.#parseRegularExpression();
      this.#finishAttribute();
      return { kind: "regex", attribute, operand, range: { start, end: this.#index } };
    }
    const operand = this.#peek() === "$" ? this.#parseCaptureReference() : this.#parseLiteral();
    this.#finishAttribute();
    return { kind: "comparison", attribute, operator, operand, range: { start, end: this.#index } };
  }

  #parsePseudo(): SelectorPseudo {
    const start = this.#index;
    this.#index += 1;
    const name = this.#parseSimpleName();
    if (name !== "not" && name !== "is" && name !== "has") {
      this.#fail("selector.unknown-predicate", `Unknown selector predicate :${name}.`, start);
    }
    this.#expect("(", `Expected \`(\` after :${name}.`);
    this.#skipWhitespace();
    const selectors = this.#parseSelectorList(name === "has");
    if (selectors.length === 0) {
      this.#fail("selector.syntax", `:${name} requires at least one selector.`, start);
    }
    this.#skipWhitespace();
    this.#expect(")", `Expected \`)\` after :${name}.`);
    return { kind: name, selectors, range: { start, end: this.#index } };
  }

  #parseCombinator(): SelectorCombinator {
    const start = this.#index;
    if (this.#source.startsWith("->", this.#index) || this.#source.startsWith("<-", this.#index)) {
      const direction = this.#peek() === "-" ? "forward" : "reverse";
      this.#index += 2;
      const name = this.#parseQualifiedName();
      return { kind: "edge", direction, name, range: { start, end: this.#index } };
    }
    const symbol = this.#peek();
    this.#index += 1;
    if (symbol === ">") return { kind: "child", range: { start, end: this.#index } };
    if (symbol === "+") return { kind: "adjacent-sibling", range: { start, end: this.#index } };
    if (symbol === "~") return { kind: "following-sibling", range: { start, end: this.#index } };
    this.#fail("selector.syntax", "Unknown selector combinator.", start);
  }

  #parseOperator(): "=" | "!=" | "<" | "<=" | ">" | ">=" | "^=" | "$=" | "*=" | "~=" {
    for (const operator of ["!=", "<=", ">=", "^=", "$=", "*=", "~=", "=", "<", ">"] as const) {
      if (this.#source.startsWith(operator, this.#index)) {
        this.#index += operator.length;
        return operator;
      }
    }
    this.#fail("selector.syntax", "Expected an attribute operator.");
  }

  #parseCaptureReference(): SelectorCaptureReference {
    const start = this.#index;
    this.#index += 1;
    const capture = this.#parseIdentifier();
    this.#expect(".", "Expected an attribute after the capture name.");
    const attribute = this.#parseSimpleName();
    return { kind: "capture-reference", capture, attribute, range: { start, end: this.#index } };
  }

  #parseRegularExpression(): SelectorRegularExpression {
    const start = this.#index;
    this.#expect("/", "Expected a regular expression literal.");
    let pattern = "";
    let escaped = false;
    while (!this.#atEnd()) {
      const character = this.#peek();
      this.#index += 1;
      if (character === "/" && !escaped) break;
      pattern += character;
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
    }
    if (this.#source[this.#index - 1] !== "/") {
      this.#fail("selector.syntax", "Unterminated regular expression.", start);
    }
    let flags = "";
    while (/[dgimsuvy]/u.test(this.#peek() ?? "")) {
      flags += this.#peek();
      this.#index += 1;
    }
    try {
      void new RegExp(pattern, flags);
    } catch {
      this.#fail("selector.invalid-regex", "Invalid regular expression.", start);
    }
    return { kind: "regular-expression", pattern, flags, range: { start, end: this.#index } };
  }

  #parseLiteral(): SelectorLiteral {
    const start = this.#index;
    const quote = this.#peek();
    if (quote === '"' || quote === "'") {
      this.#index += 1;
      let value = "";
      let escaped = false;
      while (!this.#atEnd()) {
        const character = this.#peek();
        this.#index += 1;
        if (character === quote && !escaped) {
          return { kind: "literal", value, range: { start, end: this.#index } };
        }
        if (character === "\\" && !escaped) {
          escaped = true;
          continue;
        }
        if (escaped) {
          const escapes: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };
          value += escapes[character ?? ""] ?? character;
          escaped = false;
        } else {
          value += character;
        }
      }
      this.#fail("selector.syntax", "Unterminated string literal.", start);
    }

    const remaining = this.#source.slice(this.#index);
    const keyword = /^(true|false|null)(?![A-Za-z0-9._-])/u.exec(remaining)?.[1];
    if (keyword !== undefined) {
      this.#index += keyword.length;
      return {
        kind: "literal",
        value: keyword === "null" ? null : keyword === "true",
        range: { start, end: this.#index },
      };
    }
    const bigint = /^-?(?:0|[1-9][0-9]*)n(?![A-Za-z0-9._-])/u.exec(remaining)?.[0];
    if (bigint !== undefined) {
      this.#index += bigint.length;
      return { kind: "literal", value: BigInt(bigint.slice(0, -1)), range: { start, end: this.#index } };
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remaining)?.[0];
    if (number !== undefined) {
      this.#index += number.length;
      return { kind: "literal", value: Number(number), range: { start, end: this.#index } };
    }
    this.#fail("selector.syntax", "Expected a scalar literal.", start);
  }

  #parseQualifiedName(): string {
    const namespace = this.#parseSimpleName();
    if (!this.#source.startsWith("::", this.#index)) return namespace;
    this.#index += 2;
    return `${namespace}::${this.#parseSimpleName()}`;
  }

  #parseSimpleName(): string {
    const start = this.#index;
    if (!isNameStart(this.#peek())) this.#fail("selector.syntax", "Expected a name.", start);
    this.#index += 1;
    while (isNamePart(this.#peek())) this.#index += 1;
    return this.#source.slice(start, this.#index);
  }

  #parseIdentifier(): string {
    const start = this.#index;
    if (!isNameStart(this.#peek())) this.#fail("selector.syntax", "Expected a name.", start);
    this.#index += 1;
    while (/[A-Za-z0-9_-]/u.test(this.#peek() ?? "")) this.#index += 1;
    return this.#source.slice(start, this.#index);
  }

  #finishAttribute(): void {
    this.#skipWhitespace();
    this.#expect("]", "Expected `]` after the attribute predicate.");
  }

  #expect(value: string, message: string): void {
    if (!this.#source.startsWith(value, this.#index)) this.#fail("selector.syntax", message);
    this.#index += value.length;
  }

  #startsKeyword(keyword: string): boolean {
    return (
      this.#source.startsWith(keyword, this.#index) &&
      !isNamePart(this.#source[this.#index + keyword.length])
    );
  }

  #startsCombinator(): boolean {
    return [">", "+", "~"].includes(this.#peek() ?? "") ||
      this.#source.startsWith("->", this.#index) ||
      this.#source.startsWith("<-", this.#index);
  }

  #skipWhitespace(): boolean {
    const start = this.#index;
    while (/\s/u.test(this.#peek() ?? "")) this.#index += 1;
    return this.#index > start;
  }

  #peek(): string | undefined {
    return this.#source[this.#index];
  }

  #atEnd(): boolean {
    return this.#index >= this.#source.length;
  }

  #fail(code: string, message: string, start = this.#index): never {
    throw new SelectorError([
      diagnostic(code, message, this.#uri, { start, end: Math.min(this.#source.length, Math.max(start + 1, this.#index)) }),
    ]);
  }
}

const diagnostic = (code: string, message: string, uri: string, range: SourceRange): Diagnostic =>
  defineDiagnostic({
    code,
    severity: "error",
    message,
    locations: [{ kind: "program", uri, range }],
  });

export const parseSelector = (source: string, options: SelectorOptions = {}): SelectorProgram =>
  new Parser(source, options.uri ?? "selector:").parse();

interface CaptureType {
  readonly kind?: NodeKindSchema;
}

const scalarTypeOf = (value: Scalar): ScalarType => {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "bigint";
};

const includesType = (schema: AttributeSchema, type: ScalarType): boolean =>
  (Array.isArray(schema.scalar) ? schema.scalar : [schema.scalar]).includes(type);

const kindSchema = (schema: AdapterSchema, name: string | undefined): NodeKindSchema | undefined =>
  name === undefined ? undefined : schema.kinds.find(({ kind }) => kind === name);

const attributeSchema = (
  schema: AdapterSchema,
  kind: NodeKindSchema | undefined,
  attribute: string,
): AttributeSchema | undefined =>
  kind?.attributes[attribute] ?? schema.kinds.map(({ attributes }) => attributes[attribute]).find(Boolean);

const validateName = (
  name: string,
  label: string,
  uri: string,
  range: SourceRange,
): void => {
  if (!name.includes("::")) {
    throw new SelectorError([
      diagnostic("selector.ambiguous-name", `${label} ${JSON.stringify(name)} must be namespaced.`, uri, range),
    ]);
  }
};

const validateOperandType = (
  predicate: Extract<SelectorAttributePredicate, { kind: "comparison" | "membership" }>,
  expected: AttributeSchema,
  captures: ReadonlyMap<string, CaptureType>,
  schema: AdapterSchema,
  uri: string,
): void => {
  const operands = predicate.kind === "membership" ? predicate.operands : [predicate.operand];
  for (const operand of operands) {
    if (operand.kind === "literal") {
      if (!includesType(expected, scalarTypeOf(operand.value))) {
        throw new SelectorError([
          diagnostic(
            "selector.type-mismatch",
            `Attribute ${JSON.stringify(predicate.attribute)} cannot be compared with ${scalarTypeOf(operand.value)}.`,
            uri,
            operand.range,
          ),
        ]);
      }
      continue;
    }
    const capture = captures.get(operand.capture);
    if (capture === undefined) {
      throw new SelectorError([
        diagnostic("selector.unknown-capture", `Unknown capture $${operand.capture}.`, uri, operand.range),
      ]);
    }
    const capturedAttribute = attributeSchema(schema, capture.kind, operand.attribute);
    if (capturedAttribute === undefined) {
      throw new SelectorError([
        diagnostic(
          "selector.unknown-attribute",
          `Unknown captured attribute ${JSON.stringify(operand.attribute)}.`,
          uri,
          operand.range,
        ),
      ]);
    }
    if (capturedAttribute.cardinality === "many") {
      throw new SelectorError([
        diagnostic(
          "selector.invalid-comparison",
          "A scalar comparison cannot use a multi-valued capture attribute.",
          uri,
          operand.range,
        ),
      ]);
    }
    const left = Array.isArray(expected.scalar) ? expected.scalar : [expected.scalar];
    const right = Array.isArray(capturedAttribute.scalar)
      ? capturedAttribute.scalar
      : [capturedAttribute.scalar];
    if (!left.some((type) => right.includes(type))) {
      throw new SelectorError([
        diagnostic("selector.type-mismatch", "Capture comparison has incompatible scalar types.", uri, operand.range),
      ]);
    }
  }
};

const validateCompound = (
  compound: SelectorCompound,
  schema: AdapterSchema,
  captures: Map<string, CaptureType>,
  uri: string,
): void => {
  if (compound.kind !== undefined) validateName(compound.kind, "Kind", uri, compound.range);
  const selectedKind = kindSchema(schema, compound.kind);
  if (compound.kind !== undefined && selectedKind === undefined) {
    throw new SelectorError([
      diagnostic("selector.unknown-kind", `Unknown node kind ${compound.kind}.`, uri, compound.range),
    ]);
  }

  for (const predicate of compound.attributes) {
    const attribute = attributeSchema(schema, selectedKind, predicate.attribute);
    if (attribute === undefined && predicate.kind !== "missing") {
      throw new SelectorError([
        diagnostic(
          "selector.unknown-attribute",
          `Unknown attribute ${JSON.stringify(predicate.attribute)}.`,
          uri,
          predicate.range,
        ),
      ]);
    }
    if (attribute === undefined) continue;
    if (predicate.kind === "comparison" || predicate.kind === "membership") {
      validateOperandType(predicate, attribute, captures, schema, uri);
    }
    if (
      predicate.kind === "comparison" &&
      ["<", "<=", ">", ">="].includes(predicate.operator) &&
      (Array.isArray(attribute.scalar) ? attribute.scalar : [attribute.scalar]).some(
        (type) => type === "boolean" || type === "null",
      )
    ) {
      throw new SelectorError([
        diagnostic(
          "selector.invalid-comparison",
          `Operator ${predicate.operator} is not defined for attribute ${JSON.stringify(predicate.attribute)}.`,
          uri,
          predicate.range,
        ),
      ]);
    }
    if (
      (predicate.kind === "regex" ||
        (predicate.kind === "comparison" && ["^=", "$=", "*="].includes(predicate.operator))) &&
      !includesType(attribute, "string")
    ) {
      throw new SelectorError([
        diagnostic("selector.type-mismatch", `Attribute ${JSON.stringify(predicate.attribute)} is not textual.`, uri, predicate.range),
      ]);
    }
  }

  for (const pseudo of compound.pseudos) {
    for (const sequence of pseudo.selectors) {
      validateSequence(sequence, schema, new Map(captures), uri);
    }
  }

  for (const capture of compound.captures) {
    if (captures.has(capture.name)) {
      throw new SelectorError([
        diagnostic("selector.duplicate-capture", `Capture $${capture.name} already exists.`, uri, capture.range),
      ]);
    }
    captures.set(capture.name, selectedKind === undefined ? {} : { kind: selectedKind });
  }
};

const validateCombinator = (
  combinator: SelectorCombinator,
  schema: AdapterSchema,
  uri: string,
): void => {
  if (combinator.kind === "edge") {
    validateName(combinator.name, "Edge", uri, combinator.range);
    if (!schema.edges.some(({ name }) => name === combinator.name)) {
      throw new SelectorError([
        diagnostic("selector.unknown-edge", `Unknown edge ${combinator.name}.`, uri, combinator.range),
      ]);
    }
  }
  if (
    (combinator.kind === "adjacent-sibling" || combinator.kind === "following-sibling") &&
    (schema.capabilities.ordering !== "stable" ||
      schema.edges.some(({ role, ordering }) => role === "child" && ordering !== "stable"))
  ) {
    throw new SelectorError([
      diagnostic(
        "selector.unordered-sibling",
        "Sibling selectors require stable ordering on child edges.",
        uri,
        combinator.range,
      ),
    ]);
  }
};

const validateSequence = (
  sequence: SelectorSequence,
  schema: AdapterSchema,
  captures: Map<string, CaptureType>,
  uri: string,
): void => {
  if (sequence.leading !== undefined) validateCombinator(sequence.leading, schema, uri);
  for (const step of sequence.steps) {
    if (step.combinator !== undefined) validateCombinator(step.combinator, schema, uri);
    validateCompound(step.compound, schema, captures, uri);
  }
};

export const validateSelector = (program: SelectorProgram, schema: AdapterSchema): void => {
  for (const sequence of program.selectors) validateSequence(sequence, schema, new Map(), program.uri);
};

const childEdges = (
  schema: AdapterSchema,
  treeView?: NamespacedName,
): readonly EdgeName[] => {
  const tree = treeView === undefined
    ? schema.treeViews.find(({ default: isDefault }) => isDefault === true) ?? schema.treeViews[0]
    : schema.treeViews.find(({ name }) => name === treeView);
  if (treeView !== undefined && tree === undefined) {
    throw new TypeError(`Unknown tree view ${treeView}.`);
  }
  return tree?.childEdges ?? schema.edges.filter(({ role }) => role === "child").map(({ name }) => name);
};

const nodeIdEquals = (left: NodeHandle["snapshot"]["id"], right: NodeHandle["snapshot"]["id"]): boolean =>
  left.adapter === right.adapter && left.resource === right.resource && left.local === right.local;

const resolveEdge = async (
  node: NavigableNodeHandle,
  edge: Edge,
  direction: "forward" | "reverse",
  signal?: AbortSignal,
): Promise<NavigableNodeHandle | undefined> =>
  node.resolve(direction === "forward" ? edge.to : edge.from, signal);

const traverseSingle = (
  query: Query<NavigableNodeHandle, CaptureMap>,
  combinator: SelectorCombinator,
  schema: AdapterSchema,
  treeView?: NamespacedName,
): Query<NavigableNodeHandle, CaptureMap> => {
  const treeEdges = childEdges(schema, treeView);
  if (combinator.kind === "descendant") {
    return query.traverse({ edgeNames: treeEdges, roles: ["child"], maxDepth: Number.MAX_SAFE_INTEGER });
  }
  if (combinator.kind === "child" || combinator.kind === "edge") {
    const direction = combinator.kind === "edge" ? combinator.direction : "forward";
    const names = combinator.kind === "edge" ? [combinator.name as EdgeName] : treeEdges;
    const roles = combinator.kind === "child" ? (["child"] as const) : undefined;
    return query.flatMap(async function* (node, _captures, options) {
      for await (const edge of node.edges({
        names,
        ...(roles === undefined ? {} : { roles }),
        direction,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) {
        const target = await resolveEdge(node, edge, direction, options.signal);
        if (target !== undefined) yield target;
      }
    }, combinator.kind === "child" ? "selector child" : `selector ${direction} edge`);
  }

  return query.flatMap(async function* (node, _captures, options) {
    const signal = options.signal === undefined ? {} : { signal: options.signal };
    for await (const parentEdge of node.edges({
      names: treeEdges,
      roles: ["child"],
      direction: "reverse",
      ...signal,
    })) {
      const parent = await node.resolve(parentEdge.from, options.signal);
      if (parent === undefined) continue;
      const siblings: { edge: Edge; node: NavigableNodeHandle }[] = [];
      for await (const siblingEdge of parent.edges({
        names: [parentEdge.name],
        roles: ["child"],
        ...signal,
      })) {
        const sibling = await parent.resolve(siblingEdge.to, options.signal);
        if (sibling !== undefined) siblings.push({ edge: siblingEdge, node: sibling });
      }
      const position = siblings.findIndex(({ edge }) => nodeIdEquals(edge.to, node.snapshot.id));
      if (position < 0) continue;
      const following = siblings.slice(position + 1);
      if (combinator.kind === "adjacent-sibling") {
        const adjacent = following[0];
        if (adjacent !== undefined) yield adjacent.node;
      } else {
        for (const sibling of following) yield sibling.node;
      }
    }
  }, `selector ${combinator.kind}`);
};

const operandValue = (
  operand: SelectorLiteral | SelectorCaptureReference,
  captures: CaptureMap,
): Scalar | undefined => {
  if (operand.kind === "literal") return operand.value;
  const captured = captures[operand.capture];
  if (
    captured === null ||
    typeof captured !== "object" ||
    !("snapshot" in captured)
  ) return undefined;
  const value = (captured as NavigableNodeHandle).snapshot.attributes[operand.attribute];
  return Array.isArray(value) ? undefined : (value as Scalar | undefined);
};

const scalarEquals = (left: Scalar, right: Scalar): boolean =>
  typeof left === typeof right && left === right;

const compareScalar = (
  left: Scalar,
  operator: Extract<SelectorAttributePredicate, { kind: "comparison" }>["operator"],
  right: Scalar,
): boolean => {
  if (operator === "=") return scalarEquals(left, right);
  if (operator === "!=") return !scalarEquals(left, right);
  if (typeof left !== typeof right) return false;
  if (operator === "^=") return typeof left === "string" && left.startsWith(right as string);
  if (operator === "$=") return typeof left === "string" && left.endsWith(right as string);
  if (operator === "*=") return typeof left === "string" && left.includes(right as string);
  if (typeof left === "string" && typeof right === "string") {
    if (operator === "<") return left < right;
    if (operator === "<=") return left <= right;
    if (operator === ">") return left > right;
    return left >= right;
  }
  if (typeof left === "number" && typeof right === "number") {
    if (operator === "<") return left < right;
    if (operator === "<=") return left <= right;
    if (operator === ">") return left > right;
    return left >= right;
  }
  if (typeof left === "bigint" && typeof right === "bigint") {
    if (operator === "<") return left < right;
    if (operator === "<=") return left <= right;
    if (operator === ">") return left > right;
    return left >= right;
  }
  return false;
};

const valuesOf = (value: AttributeValue): readonly Scalar[] =>
  Array.isArray(value) ? value : [value as Scalar];

const matchesAttribute = (
  node: NavigableNodeHandle,
  predicate: SelectorAttributePredicate,
  captures: CaptureMap,
): boolean => {
  const attributes = node.snapshot.attributes;
  const present = Object.hasOwn(attributes, predicate.attribute);
  if (predicate.kind === "exists") return present;
  if (predicate.kind === "missing") return !present;
  if (predicate.kind === "null") return present && attributes[predicate.attribute] === null;
  if (!present) return false;
  const value = attributes[predicate.attribute];
  if (value === undefined) return false;
  if (predicate.kind === "membership") {
    return valuesOf(value).some((candidate) =>
      predicate.operands.some((operand) => scalarEquals(candidate, operand.value)),
    );
  }
  if (predicate.kind === "regex") {
    return valuesOf(value).some(
      (candidate) =>
        typeof candidate === "string" &&
        new RegExp(predicate.operand.pattern, predicate.operand.flags).test(candidate),
    );
  }
  if (predicate.kind !== "comparison") return false;
  const right = operandValue(predicate.operand, captures);
  if (right === undefined) return false;
  if (predicate.operator === "!=") {
    return valuesOf(value).every((candidate) => !scalarEquals(candidate, right));
  }
  if (predicate.operator === "*=" && Array.isArray(value)) {
    return value.some((candidate) => scalarEquals(candidate, right));
  }
  return valuesOf(value).some((candidate) => compareScalar(candidate, predicate.operator, right));
};

const matchesCompound = async (
  node: NavigableNodeHandle,
  captures: CaptureMap,
  compound: SelectorCompound,
  schema: AdapterSchema,
  options: ExecuteOptions,
  treeView?: NamespacedName,
): Promise<boolean> => {
  if (compound.kind !== undefined && node.snapshot.kind !== compound.kind) return false;
  if (!compound.attributes.every((predicate) => matchesAttribute(node, predicate, captures))) return false;
  for (const pseudo of compound.pseudos) {
    let anyMatch = false;
    for (const sequence of pseudo.selectors) {
      const query = compileAnchored(
        node,
        sequence,
        schema,
        captures,
        pseudo.kind === "has",
        treeView,
      );
      // Adapters do not imply parallel read safety, so alternatives are tested in order.
      // oxlint-disable-next-line no-await-in-loop
      if ((await query.take(1).toArray(options)).length > 0) {
        anyMatch = true;
        break;
      }
    }
    if ((pseudo.kind === "not") === anyMatch) return false;
  }
  return true;
};

const applyCompound = (
  query: Query<NavigableNodeHandle, CaptureMap>,
  compound: SelectorCompound,
  schema: AdapterSchema,
  ambient: CaptureMap = {},
  treeView?: NamespacedName,
): Query<NavigableNodeHandle, CaptureMap> => {
  let result = query.filter(
    (node, captures, options) =>
      matchesCompound(
        node,
        Object.freeze({ ...ambient, ...captures }),
        compound,
        schema,
        options,
        treeView,
      ),
    "selector predicate",
  );
  for (const { name } of compound.captures) {
    result = result.capture(name) as Query<NavigableNodeHandle, CaptureMap>;
  }
  return result;
};

const compileAnchored = (
  node: NavigableNodeHandle,
  sequence: SelectorSequence,
  schema: AdapterSchema,
  ambient: CaptureMap,
  relative: boolean,
  treeView?: NamespacedName,
): Query<NavigableNodeHandle, CaptureMap> => {
  let query = fromValues([node]) as Query<NavigableNodeHandle, CaptureMap>;
  const first = sequence.steps[0];
  if (first === undefined) return query.take(0);
  const leading = sequence.leading ?? (relative ? { kind: "descendant", range: sequence.range } : undefined);
  if (leading !== undefined) query = traverseSingle(query, leading, schema, treeView);
  query = applyCompound(query, first.compound, schema, ambient, treeView);
  for (const step of sequence.steps.slice(1)) {
    if (step.combinator !== undefined) {
      query = traverseSingle(query, step.combinator, schema, treeView);
    }
    query = applyCompound(query, step.compound, schema, ambient, treeView);
  }
  return query;
};

const compileSequence = (
  roots: Query<NavigableNodeHandle, CaptureMap>,
  sequence: SelectorSequence,
  schema: AdapterSchema,
  treeView?: NamespacedName,
): Query<NavigableNodeHandle, CaptureMap> => {
  const first = sequence.steps[0];
  if (first === undefined) return roots.take(0);
  let query = applyCompound(roots, first.compound, schema, {}, treeView);
  for (const step of sequence.steps.slice(1)) {
    if (step.combinator !== undefined) {
      query = traverseSingle(query, step.combinator, schema, treeView);
    }
    query = applyCompound(query, step.compound, schema, {}, treeView);
  }
  return query;
};

export const select = (
  adapter: Adapter,
  source: SourceDescriptor,
  selector: string | SelectorProgram,
  options: SelectorOptions = {},
): Query<NavigableNodeHandle, CaptureMap> => {
  const selectedSource: SourceDescriptor = options.treeView === undefined
    ? source
    : { ...source, treeView: options.treeView };
  return selectFrom(
    fromAdapter(adapter, selectedSource) as Query<NavigableNodeHandle, CaptureMap>,
    adapter.schema,
    selector,
    options,
  );
};

export const selectFrom = (
  source: Query<NavigableNodeHandle, CaptureMap>,
  schema: AdapterSchema,
  selector: string | SelectorProgram,
  options: SelectorOptions = {},
): Query<NavigableNodeHandle, CaptureMap> => {
  const program = typeof selector === "string" ? parseSelector(selector, options) : selector;
  validateSelector(program, schema);
  const roots = options.sourceMode === "selection"
    ? source
    : source.traverse({
        edgeNames: childEdges(schema, options.treeView),
        roles: ["child"],
        maxDepth: Number.MAX_SAFE_INTEGER,
        includeSelf: true,
      });
  const sequence = program.selectors[0];
  return sequence === undefined
    ? roots.take(0)
    : compileSequence(roots, sequence, schema, options.treeView);
};
