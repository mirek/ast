import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  Adapter,
  ApplyCapability,
  ApplyResult,
  AttributeProjection,
  OpenContext,
  Operation,
  PlanningCapability,
  ReadCapability,
  ResourceHandle,
  RootRequest,
  SourceDescriptor,
} from "./adapter.js";
import type {
  Change,
  ChangePrecondition,
  ChangeRegion,
  ChangeTransaction,
  TextChangePreview,
} from "./change.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import { defineEdge, defineNodeSnapshot, defineResource } from "./model.js";
import type {
  Edge,
  EdgeRequest,
  NodeId,
  NodeSnapshot,
  Resource,
  Revision,
  SourceRange,
} from "./model.js";
import type {
  CaptureMap,
  NavigableNodeHandle,
  Query,
} from "./query.js";
import { defineAdapterSchema } from "./schema.js";
import type { IdentityGuarantee, NodeKindSchema } from "./schema.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [name: string]: JsonValue };

export type JsonNodeKind =
  | "json::root"
  | "json::object"
  | "json::property"
  | "json::array"
  | "json::index"
  | "json::scalar";

export type JsonOperationKind =
  | "json::replace-value"
  | "json::insert-property"
  | "json::remove-property"
  | "json::insert-array-item"
  | "json::remove-array-item";

interface JsonOperationBase<Kind extends JsonOperationKind, Payload>
  extends Operation<Kind, Payload> {
  readonly target: NodeId;
  readonly expectedRevision?: Revision;
}

export type JsonReplaceValueOperation = JsonOperationBase<
  "json::replace-value",
  { readonly value: JsonValue }
>;
export type JsonInsertPropertyOperation = JsonOperationBase<
  "json::insert-property",
  { readonly name: string; readonly value: JsonValue }
>;
export type JsonRemovePropertyOperation = JsonOperationBase<
  "json::remove-property",
  Readonly<Record<never, never>>
>;
export type JsonInsertArrayItemOperation = JsonOperationBase<
  "json::insert-array-item",
  { readonly index: number; readonly value: JsonValue }
>;
export type JsonRemoveArrayItemOperation = JsonOperationBase<
  "json::remove-array-item",
  Readonly<Record<never, never>>
>;
export type JsonOperation =
  | JsonReplaceValueOperation
  | JsonInsertPropertyOperation
  | JsonRemovePropertyOperation
  | JsonInsertArrayItemOperation
  | JsonRemoveArrayItemOperation;

export interface JsonPrecondition extends ChangePrecondition {
  readonly expectedRevision: Revision;
}

export interface JsonPatchPayload {
  readonly uri: string;
  readonly encoding: "utf8" | "utf8-bom";
  readonly finalNewline: boolean;
  readonly strategy: "localized-text-patch";
  readonly range: SourceRange;
  readonly replacement: string;
  readonly original: string;
  readonly content: string;
  readonly formatting: string;
}

export interface JsonChange extends Change<JsonPatchPayload> {
  readonly adapter: "json";
  readonly kind: JsonOperationKind;
  readonly risk: "safe" | "destructive";
  readonly reversible: true;
  readonly preconditions: readonly JsonPrecondition[];
  readonly regions: readonly ChangeRegion[];
  readonly preview: TextChangePreview;
  readonly transaction: ChangeTransaction;
}

export interface JsonStatistics {
  readonly opened: number;
  readonly closed: number;
  readonly filesRead: number;
  readonly bytesRead: number;
  readonly parses: number;
}

export interface JsonMountOptions {
  readonly onError?: "skip" | "throw";
}

export interface JsonAdapter extends Adapter {
  readonly namespace: "json";
  readonly read: ReadCapability;
  readonly planning: PlanningCapability<JsonOperation, JsonChange>;
  readonly apply: ApplyCapability<JsonChange, ApplyResult>;
  diagnostics(): readonly Diagnostic[];
  statistics(): JsonStatistics;
}

type JsonSyntax = JsonObjectSyntax | JsonArraySyntax | JsonScalarSyntax;

interface JsonSyntaxBase {
  readonly start: number;
  readonly end: number;
  readonly value: JsonValue;
}

interface JsonPropertySyntax {
  readonly start: number;
  readonly end: number;
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly name: string;
  readonly value: JsonSyntax;
}

interface JsonObjectSyntax extends JsonSyntaxBase {
  readonly type: "object";
  readonly value: { readonly [name: string]: JsonValue };
  readonly properties: readonly JsonPropertySyntax[];
}

interface JsonArraySyntax extends JsonSyntaxBase {
  readonly type: "array";
  readonly value: readonly JsonValue[];
  readonly items: readonly JsonSyntax[];
}

interface JsonScalarSyntax extends JsonSyntaxBase {
  readonly type: "string" | "number" | "boolean" | "null";
  readonly value: JsonPrimitive;
}

interface NodeRecord {
  readonly snapshot: NodeSnapshot;
  readonly syntax: JsonSyntax;
  readonly parent?: string;
  readonly childLocals: readonly string[];
  readonly property?: JsonPropertySyntax;
  readonly itemIndex?: number;
}

interface ResourceState {
  readonly resource: Resource;
  readonly path?: string;
  readonly text: string;
  readonly bom: boolean;
  readonly finalNewline: boolean;
  readonly newline: "\n" | "\r\n" | "\r";
  readonly indent: string;
  readonly rootSyntax: JsonSyntax;
  readonly nodes: ReadonlyMap<string, NodeRecord>;
  readonly container?: NodeSnapshot;
}

interface MutableStatistics {
  opened: number;
  closed: number;
  filesRead: number;
  bytesRead: number;
  parses: number;
}

class JsonSyntaxFailure extends SyntaxError {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = "JsonSyntaxFailure";
    this.offset = offset;
  }
}

const jsonIdentity: IdentityGuarantee = Object.freeze({
  stability: "revision",
  description: "source-order structural path within one JSON document revision",
});

const jsonKinds: readonly NodeKindSchema[] = [
  {
    kind: "json::root",
    attributes: {
      encoding: { scalar: "string", cardinality: "one", required: true },
      finalNewline: { scalar: "boolean", cardinality: "one", required: true },
    },
    identity: jsonIdentity,
  },
  {
    kind: "json::object",
    attributes: { size: { scalar: "number", cardinality: "one", required: true } },
    identity: jsonIdentity,
  },
  {
    kind: "json::property",
    attributes: { name: { scalar: "string", cardinality: "one", required: true } },
    identity: jsonIdentity,
  },
  {
    kind: "json::array",
    attributes: { size: { scalar: "number", cardinality: "one", required: true } },
    identity: jsonIdentity,
  },
  {
    kind: "json::index",
    attributes: { index: { scalar: "number", cardinality: "one", required: true } },
    identity: jsonIdentity,
  },
  {
    kind: "json::scalar",
    attributes: {
      valueType: { scalar: "string", cardinality: "one", required: true },
      value: {
        scalar: ["string", "number", "boolean", "null"],
        cardinality: "one",
        required: true,
      },
    },
    identity: jsonIdentity,
  },
];

const schema = defineAdapterSchema({
  namespace: "json",
  version: "1.0.0",
  dynamic: false,
  kinds: jsonKinds,
  edges: [
    {
      name: "json::mount",
      role: "child",
      from: ["fs::file", "markdown::code-block"],
      to: ["json::root"],
      ordering: "stable",
    },
    {
      name: "json::children",
      role: "child",
      from: ["json::root", "json::object", "json::property", "json::array", "json::index"],
      to: ["json::object", "json::property", "json::array", "json::index", "json::scalar"],
      ordering: "stable",
    },
    {
      name: "json::container",
      role: "reference",
      from: ["json::root"],
      to: ["fs::file", "markdown::code-block"],
      ordering: "stable",
    },
  ],
  operations: [
    { kind: "json::replace-value", arguments: { value: { type: "unknown", cardinality: "one", required: true } } },
    {
      kind: "json::insert-property",
      arguments: {
        name: { type: "string", cardinality: "one", required: true },
        value: { type: "unknown", cardinality: "one", required: true },
      },
    },
    { kind: "json::remove-property", arguments: {} },
    {
      kind: "json::insert-array-item",
      arguments: {
        index: { type: "number", cardinality: "one", required: true },
        value: { type: "unknown", cardinality: "one", required: true },
      },
    },
    { kind: "json::remove-array-item", arguments: {} },
  ],
  treeViews: [
    {
      name: "json::document-tree",
      rootKinds: ["json::root"],
      childEdges: ["json::mount", "json::children"],
      default: true,
    },
  ],
  capabilities: {
    traversal: ["tree", "reference"],
    pushdown: [],
    ordering: "stable",
    revisions: true,
    transactions: "local",
    semanticOperations: true,
    parallelReads: true,
    parallelWrites: false,
  },
});

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

const sourcePath = (uri: string): string =>
  uri.startsWith("file:") ? fileURLToPath(uri) : uri;

const revisionOf = (stat: Awaited<ReturnType<typeof lstat>>): Revision =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

const resourceKey = (uri: string, container: NodeSnapshot | undefined): string => {
  const owner = container === undefined
    ? "standalone"
    : `${container.id.adapter}\0${container.id.resource}\0${container.id.local}`;
  return createHash("sha256")
    .update("json\0")
    .update(uri)
    .update("\0")
    .update(owner)
    .digest("base64url")
    .slice(0, 24);
};

class JsonParser {
  readonly #source: string;
  #index = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(): JsonSyntax {
    this.#skipWhitespace();
    const value = this.#parseValue();
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) this.#fail("Unexpected content after the JSON value.");
    return value;
  }

  #parseValue(): JsonSyntax {
    const character = this.#source[this.#index];
    if (character === "{") return this.#parseObject();
    if (character === "[") return this.#parseArray();
    if (character === '"') return this.#parseString();
    if (character === "t") return this.#parseKeyword("true", true, "boolean");
    if (character === "f") return this.#parseKeyword("false", false, "boolean");
    if (character === "n") return this.#parseKeyword("null", null, "null");
    if (character === "-" || (character !== undefined && /[0-9]/u.test(character))) {
      return this.#parseNumber();
    }
    this.#fail("Expected a JSON value.");
  }

  #parseObject(): JsonObjectSyntax {
    const start = this.#index;
    this.#index += 1;
    this.#skipWhitespace();
    const properties: JsonPropertySyntax[] = [];
    const value: Record<string, JsonValue> = {};
    if (this.#source[this.#index] === "}") {
      this.#index += 1;
      return { type: "object", start, end: this.#index, value, properties };
    }
    while (true) {
      const propertyStart = this.#index;
      if (this.#source[this.#index] !== '"') this.#fail("Expected a quoted object property name.");
      const key = this.#parseString();
      const keyEnd = this.#index;
      this.#skipWhitespace();
      if (this.#source[this.#index] !== ":") this.#fail("Expected `:` after an object property name.");
      this.#index += 1;
      this.#skipWhitespace();
      const propertyValue = this.#parseValue();
      const name = key.value;
      if (typeof name !== "string") this.#fail("Expected a string property name.");
      properties.push({
        start: propertyStart,
        end: propertyValue.end,
        keyStart: key.start,
        keyEnd,
        name,
        value: propertyValue,
      });
      value[name] = propertyValue.value;
      this.#skipWhitespace();
      const separator = this.#source[this.#index];
      if (separator === "}") {
        this.#index += 1;
        break;
      }
      if (separator !== ",") this.#fail("Expected `,` or `}` after an object property.");
      this.#index += 1;
      this.#skipWhitespace();
    }
    return { type: "object", start, end: this.#index, value, properties };
  }

  #parseArray(): JsonArraySyntax {
    const start = this.#index;
    this.#index += 1;
    this.#skipWhitespace();
    const items: JsonSyntax[] = [];
    if (this.#source[this.#index] === "]") {
      this.#index += 1;
      return { type: "array", start, end: this.#index, value: [], items };
    }
    while (true) {
      items.push(this.#parseValue());
      this.#skipWhitespace();
      const separator = this.#source[this.#index];
      if (separator === "]") {
        this.#index += 1;
        break;
      }
      if (separator !== ",") this.#fail("Expected `,` or `]` after an array item.");
      this.#index += 1;
      this.#skipWhitespace();
    }
    return {
      type: "array",
      start,
      end: this.#index,
      value: items.map(({ value }) => value),
      items,
    };
  }

  #parseString(): JsonScalarSyntax {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.#source.length) {
      const character = this.#source[this.#index];
      if (character !== undefined && character.charCodeAt(0) < 0x20) {
        this.#fail("Unescaped control character in a JSON string.");
      }
      this.#index += 1;
      if (character === '"' && !escaped) {
        const source = this.#source.slice(start, this.#index);
        try {
          return { type: "string", start, end: this.#index, value: JSON.parse(source) as string };
        } catch {
          this.#fail("Invalid escape sequence in a JSON string.", start);
        }
      }
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
    }
    this.#fail("Unterminated JSON string.", start);
  }

  #parseNumber(): JsonScalarSyntax {
    const start = this.#index;
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
    match.lastIndex = start;
    const source = match.exec(this.#source)?.[0];
    if (source === undefined) this.#fail("Invalid JSON number.");
    this.#index += source.length;
    const following = this.#source[this.#index];
    if (
      following !== undefined &&
      following !== "]" &&
      !/[\s,}]/u.test(following)
    ) {
      this.#fail("Invalid JSON number.", start);
    }
    const value = Number(source);
    if (!Number.isFinite(value)) this.#fail("JSON number is outside the supported finite range.", start);
    return { type: "number", start, end: this.#index, value };
  }

  #parseKeyword(
    keyword: "true" | "false" | "null",
    value: boolean | null,
    type: "boolean" | "null",
  ): JsonScalarSyntax {
    const start = this.#index;
    if (!this.#source.startsWith(keyword, start)) this.#fail(`Expected ${keyword}.`);
    this.#index += keyword.length;
    return { type, start, end: this.#index, value };
  }

  #skipWhitespace(): void {
    while (/[\t\n\r ]/u.test(this.#source[this.#index] ?? "")) this.#index += 1;
  }

  #fail(message: string, offset = this.#index): never {
    throw new JsonSyntaxFailure(message, offset);
  }
}

const positionAt = (source: string, offset: number): { readonly line: number; readonly column: number } => {
  let line = 0;
  let column = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
};

const sourceRange = (source: string, start: number, end: number): SourceRange => {
  const from = positionAt(source, start);
  const to = positionAt(source, end);
  return {
    start,
    end,
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column,
  };
};

const inferIndent = (source: string): string => {
  const match = /(?:^|\r?\n)([\t ]+)\S/u.exec(source);
  return match?.[1] ?? "  ";
};

const localChild = (parent: string, role: string, ordinal: number): string =>
  `${parent}/${role}:${ordinal}`;

const buildNodeRecords = (
  resource: Resource,
  text: string,
  syntax: JsonSyntax,
  bom: boolean,
  finalNewline: boolean,
): ReadonlyMap<string, NodeRecord> => {
  const records = new Map<string, NodeRecord>();
  const origin = (range: SourceRange) => ({
    uri: resource.uri,
    ...(resource.revision === undefined ? {} : { revision: resource.revision }),
    range,
  });
  const addValue = (
    value: JsonSyntax,
    local: string,
    parent: string,
    itemIndex?: number,
  ): void => {
    let kind: JsonNodeKind;
    let attributes: NodeSnapshot["attributes"];
    let childLocals: readonly string[];
    if (value.type === "object") {
      kind = "json::object";
      attributes = { size: value.properties.length };
      childLocals = value.properties.map((_, index) => localChild(local, "property", index));
    } else if (value.type === "array") {
      kind = "json::array";
      attributes = { size: value.items.length };
      childLocals = value.items.map((_, index) => localChild(local, "index", index));
    } else {
      kind = "json::scalar";
      attributes = { valueType: value.type, value: value.value };
      childLocals = [];
    }
    records.set(local, {
      snapshot: defineNodeSnapshot({
        id: { adapter: "json", resource: resource.id, local },
        kind,
        attributes,
        origin: origin(sourceRange(text, value.start, value.end)),
      }),
      syntax: value,
      parent,
      childLocals,
      ...(itemIndex === undefined ? {} : { itemIndex }),
    });

    if (value.type === "object") {
      value.properties.forEach((property, index) => {
        const propertyLocal = localChild(local, "property", index);
        const valueLocal = localChild(propertyLocal, "value", 0);
        records.set(propertyLocal, {
          snapshot: defineNodeSnapshot({
            id: { adapter: "json", resource: resource.id, local: propertyLocal },
            kind: "json::property",
            attributes: { name: property.name },
            origin: origin(sourceRange(text, property.start, property.end)),
          }),
          syntax: property.value,
          parent: local,
          childLocals: [valueLocal],
          property,
          itemIndex: index,
        });
        addValue(property.value, valueLocal, propertyLocal);
      });
    } else if (value.type === "array") {
      value.items.forEach((item, index) => {
        const indexLocal = localChild(local, "index", index);
        const valueLocal = localChild(indexLocal, "value", 0);
        records.set(indexLocal, {
          snapshot: defineNodeSnapshot({
            id: { adapter: "json", resource: resource.id, local: indexLocal },
            kind: "json::index",
            attributes: { index },
            origin: origin(sourceRange(text, item.start, item.end)),
          }),
          syntax: item,
          parent: local,
          childLocals: [valueLocal],
          itemIndex: index,
        });
        addValue(item, valueLocal, indexLocal, index);
      });
    }
  };

  const valueLocal = localChild("$", "value", 0);
  records.set("$", {
    snapshot: defineNodeSnapshot({
      id: { adapter: "json", resource: resource.id, local: "$" },
      kind: "json::root",
      attributes: { encoding: bom ? "utf8-bom" : "utf8", finalNewline },
      origin: origin(sourceRange(text, 0, text.length)),
    }),
    syntax,
    childLocals: [valueLocal],
  });
  addValue(syntax, valueLocal, "$");
  return records;
};

const assertJsonValue: (
  value: unknown,
  seen?: Set<object>,
) => asserts value is JsonValue = (value, seen = new Set<object>()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError("JSON numbers must be finite.");
  }
  if (typeof value !== "object") throw new TypeError("Expected a JSON-compatible value.");
  if (seen.has(value)) throw new TypeError("JSON values must not contain cycles.");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects.");
    }
    for (const item of Object.values(value)) assertJsonValue(item, seen);
  }
  seen.delete(value);
};

const operationTarget = (snapshot: NodeSnapshot) => ({
  resource: snapshot.id.resource,
  target: snapshot.id,
  ...(snapshot.origin?.revision === undefined
    ? {}
    : { expectedRevision: snapshot.origin.revision }),
});

const assertKind: (
  snapshot: NodeSnapshot,
  kinds: readonly JsonNodeKind[],
) => void = (snapshot, kinds) => {
  if (snapshot.id.adapter !== "json" || !kinds.includes(snapshot.kind as JsonNodeKind)) {
    throw new TypeError(`Expected a JSON ${kinds.map((kind) => kind.slice(6)).join(" or ")} node.`);
  }
};

export const jsonReplaceValue = (
  snapshot: NodeSnapshot,
  value: JsonValue,
): JsonReplaceValueOperation => {
  assertKind(snapshot, ["json::root", "json::object", "json::array", "json::scalar"]);
  assertJsonValue(value);
  return immutableCopy({
    kind: "json::replace-value",
    ...operationTarget(snapshot),
    payload: { value },
  });
};

export const jsonInsertProperty = (
  object: NodeSnapshot,
  name: string,
  value: JsonValue,
): JsonInsertPropertyOperation => {
  assertKind(object, ["json::object"]);
  assertJsonValue(value);
  return immutableCopy({
    kind: "json::insert-property",
    ...operationTarget(object),
    payload: { name, value },
  });
};

export const jsonRemoveProperty = (
  property: NodeSnapshot,
): JsonRemovePropertyOperation => {
  assertKind(property, ["json::property"]);
  return immutableCopy({
    kind: "json::remove-property",
    ...operationTarget(property),
    payload: {},
  });
};

export const jsonInsertArrayItem = (
  array: NodeSnapshot,
  index: number,
  value: JsonValue,
): JsonInsertArrayItemOperation => {
  assertKind(array, ["json::array"]);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("Inserted JSON array index must be a non-negative safe integer.");
  }
  assertJsonValue(value);
  return immutableCopy({
    kind: "json::insert-array-item",
    ...operationTarget(array),
    payload: { index, value },
  });
};

export const jsonRemoveArrayItem = (
  index: NodeSnapshot,
): JsonRemoveArrayItemOperation => {
  assertKind(index, ["json::index"]);
  return immutableCopy({
    kind: "json::remove-array-item",
    ...operationTarget(index),
    payload: {},
  });
};

const lineIndentAt = (source: string, offset: number): string => {
  const lineStart = Math.max(source.lastIndexOf("\n", offset - 1) + 1, 0);
  return /^[\t ]*/u.exec(source.slice(lineStart, offset))?.[0] ?? "";
};

const formattedValue = (
  value: JsonValue,
  state: ResourceState,
  baseIndent: string,
): string => {
  const serialized = JSON.stringify(value, undefined, state.indent);
  if (!/[\r\n]/u.test(state.text)) return JSON.stringify(value);
  return serialized
    .replaceAll("\n", state.newline)
    .replaceAll(state.newline, `${state.newline}${baseIndent}`);
};

const childIndent = (state: ResourceState, syntax: JsonObjectSyntax | JsonArraySyntax): string => {
  const children = syntax.type === "object" ? syntax.properties : syntax.items;
  const first = children[0];
  return first === undefined
    ? `${lineIndentAt(state.text, syntax.start)}${state.indent}`
    : lineIndentAt(state.text, first.start);
};

const isMultiline = (state: ResourceState, syntax: JsonSyntax): boolean =>
  state.text.slice(syntax.start, syntax.end).includes("\n");

const patchPayload = (
  state: ResourceState,
  start: number,
  end: number,
  replacement: string,
  formatting: string,
): JsonPatchPayload => {
  const patched = `${state.text.slice(0, start)}${replacement}${state.text.slice(end)}`;
  return immutableCopy({
    uri: state.resource.uri,
    encoding: state.bom ? "utf8-bom" : "utf8",
    finalNewline: state.finalNewline,
    strategy: "localized-text-patch",
    range: sourceRange(state.text, start, end),
    replacement,
    original: `${state.bom ? "\uFEFF" : ""}${state.text}`,
    content: `${state.bom ? "\uFEFF" : ""}${patched}`,
    formatting,
  });
};

const equalJsonValues = (left: JsonValue, right: JsonValue): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const replacePatch = (
  state: ResourceState,
  record: NodeRecord,
  value: JsonValue,
): JsonPatchPayload => {
  const syntax = record.syntax;
  const replacement = equalJsonValues(syntax.value, value)
    ? state.text.slice(syntax.start, syntax.end)
    : formattedValue(value, state, lineIndentAt(state.text, syntax.start));
  return patchPayload(
    state,
    syntax.start,
    syntax.end,
    replacement,
    "The selected value range is replaced; surrounding whitespace and the rest of the document are retained.",
  );
};

const insertPropertyPatch = (
  state: ResourceState,
  record: NodeRecord,
  name: string,
  value: JsonValue,
): JsonPatchPayload => {
  if (record.syntax.type !== "object") throw new TypeError("Expected a JSON object node.");
  const object = record.syntax;
  if (object.properties.some((property) => property.name === name)) {
    throw new TypeError(`JSON property ${JSON.stringify(name)} already exists.`);
  }
  const key = JSON.stringify(name);
  const indent = childIndent(state, object);
  const serialized = formattedValue(value, state, indent);
  const last = object.properties.at(-1);
  let start: number;
  let end: number;
  let replacement: string;
  if (last === undefined) {
    start = object.start + 1;
    end = object.end - 1;
    replacement = isMultiline(state, object)
      ? `${state.newline}${indent}${key}: ${serialized}${state.newline}${lineIndentAt(state.text, object.start)}`
      : `${key}:${serialized}`;
  } else if (isMultiline(state, object)) {
    start = last.end;
    end = object.end - 1;
    replacement = `,${state.newline}${indent}${key}: ${serialized}${state.text.slice(last.end, object.end - 1)}`;
  } else {
    start = last.end;
    end = last.end;
    replacement = `,${key}:${serialized}`;
  }
  return patchPayload(
    state,
    start,
    end,
    replacement,
    "The property is appended using the document's observed newline and indentation style.",
  );
};

const removalRange = (
  containerStart: number,
  containerEnd: number,
  entries: readonly { readonly start: number; readonly end: number }[],
  index: number,
): { readonly start: number; readonly end: number } => {
  const current = entries[index];
  if (current === undefined) throw new RangeError("JSON child index is outside its container.");
  if (entries.length === 1) return { start: containerStart + 1, end: containerEnd - 1 };
  const next = entries[index + 1];
  if (next !== undefined) return { start: current.start, end: next.start };
  const previous = entries[index - 1];
  if (previous === undefined) throw new RangeError("JSON child has no neighboring range.");
  return { start: previous.end, end: current.end };
};

const removePropertyPatch = (
  state: ResourceState,
  record: NodeRecord,
): JsonPatchPayload => {
  const parent = record.parent === undefined ? undefined : state.nodes.get(record.parent);
  if (parent?.syntax.type !== "object" || record.itemIndex === undefined) {
    throw new TypeError("JSON property ownership is unavailable.");
  }
  const range = removalRange(
    parent.syntax.start,
    parent.syntax.end,
    parent.syntax.properties,
    record.itemIndex,
  );
  return patchPayload(
    state,
    range.start,
    range.end,
    "",
    "The property and one adjacent comma are removed; all unrelated source text is retained.",
  );
};

const insertArrayItemPatch = (
  state: ResourceState,
  record: NodeRecord,
  index: number,
  value: JsonValue,
): JsonPatchPayload => {
  if (record.syntax.type !== "array") throw new TypeError("Expected a JSON array node.");
  const array = record.syntax;
  if (index > array.items.length) {
    throw new RangeError(`JSON array insertion index ${index} exceeds length ${array.items.length}.`);
  }
  const indent = childIndent(state, array);
  const serialized = formattedValue(value, state, indent);
  const existing = array.items[index];
  let start: number;
  let end: number;
  let replacement: string;
  if (existing !== undefined) {
    start = existing.start;
    end = existing.start;
    if (isMultiline(state, array)) {
      replacement = `${serialized},${state.newline}${indent}`;
    } else {
      const previous = array.items[index - 1];
      const separatorWhitespace = previous === undefined
        ? state.text.slice(array.start + 1, existing.start)
        : state.text.slice(previous.end + 1, existing.start);
      replacement = `${serialized},${separatorWhitespace}`;
    }
  } else {
    const last = array.items.at(-1);
    if (last === undefined) {
      start = array.start + 1;
      end = array.end - 1;
      replacement = isMultiline(state, array)
        ? `${state.newline}${indent}${serialized}${state.newline}${lineIndentAt(state.text, array.start)}`
        : serialized;
    } else if (isMultiline(state, array)) {
      start = last.end;
      end = array.end - 1;
      replacement = `,${state.newline}${indent}${serialized}${state.text.slice(last.end, array.end - 1)}`;
    } else {
      start = last.end;
      end = last.end;
      replacement = `, ${serialized}`;
    }
  }
  return patchPayload(
    state,
    start,
    end,
    replacement,
    "The array item is inserted at the requested source-order position using the surrounding style.",
  );
};

const removeArrayItemPatch = (
  state: ResourceState,
  record: NodeRecord,
): JsonPatchPayload => {
  const parent = record.parent === undefined ? undefined : state.nodes.get(record.parent);
  if (parent?.syntax.type !== "array" || record.itemIndex === undefined) {
    throw new TypeError("JSON array-index ownership is unavailable.");
  }
  const range = removalRange(
    parent.syntax.start,
    parent.syntax.end,
    parent.syntax.items,
    record.itemIndex,
  );
  return patchPayload(
    state,
    range.start,
    range.end,
    "",
    "The array item and one adjacent comma are removed; all unrelated source text is retained.",
  );
};

const mountedJsonHandle = (
  adapter: JsonAdapter,
  snapshot: NodeSnapshot,
  container: NavigableNodeHandle | undefined,
): NavigableNodeHandle =>
  Object.freeze({
    snapshot,
    edges(request: EdgeRequest = {}) {
      return adapter.read.edges(snapshot.id, request);
    },
    async resolve(id: NodeId, signal?: AbortSignal) {
      throwIfAborted(signal);
      if (id.adapter !== "json") {
        if (container === undefined) return undefined;
        if (
          id.adapter === container.snapshot.id.adapter &&
          id.resource === container.snapshot.id.resource &&
          id.local === container.snapshot.id.local
        ) {
          return container;
        }
        return container.resolve(id, signal);
      }
      const [resolved] = await adapter.read.hydrate([id], {
        attributes: [],
        ...(signal === undefined ? {} : { signal }),
      });
      return resolved === undefined
        ? undefined
        : mountedJsonHandle(adapter, resolved, container);
    },
  });

interface JsonAdapterInternals {
  openMounted(
    container: NodeSnapshot,
    context: OpenContext,
    onError: "skip" | "throw",
  ): Promise<ResourceHandle | undefined>;
  openTextMounted(
    container: NodeSnapshot,
    source: JsonTextMountSource,
    context: OpenContext,
    onError: "skip" | "throw",
  ): Promise<ResourceHandle | undefined>;
}

export interface JsonTextMountSource {
  readonly text: string;
  readonly uri: string;
  readonly revision?: Revision;
}

const adapterInternals = new WeakMap<JsonAdapter, JsonAdapterInternals>();

const requested = (
  request: EdgeRequest,
  name: "json::mount",
  role: "child",
): boolean =>
  (request.names === undefined || request.names.includes(name)) &&
  (request.roles === undefined || request.roles.includes(role)) &&
  (request.direction ?? "forward") === "forward";

const mountedFilesystemHandle = (
  file: NavigableNodeHandle,
  adapter: JsonAdapter,
  onError: "skip" | "throw",
): NavigableNodeHandle =>
  Object.freeze({
    snapshot: file.snapshot,
    edges(request: EdgeRequest = {}) {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const edge of file.edges(request)) yield edge;
          if (file.snapshot.kind !== "fs::file" || !requested(request, "json::mount", "child")) {
            return;
          }
          const internals = adapterInternals.get(adapter);
          if (internals === undefined) throw new TypeError("Unknown JSON adapter instance.");
          const handle = await internals.openMounted(
            file.snapshot,
            request.signal === undefined ? {} : { signal: request.signal },
            onError,
          );
          if (handle === undefined) return;
          try {
            for await (const root of adapter.read.roots(handle.resource, request)) {
              yield defineEdge({
                name: "json::mount",
                role: "child",
                from: file.snapshot.id,
                to: root.id,
                ordinal: 0,
              });
            }
          } finally {
            await handle.close();
          }
        },
      };
    },
    async resolve(id: NodeId, signal?: AbortSignal) {
      if (id.adapter !== "json") return file.resolve(id, signal);
      const [resolved] = await adapter.read.hydrate([id], {
        attributes: [],
        ...(signal === undefined ? {} : { signal }),
      });
      return resolved === undefined
        ? undefined
        : mountedJsonHandle(adapter, resolved, file);
    },
  });

export const mountJson = <Captures extends CaptureMap>(
  files: Query<NavigableNodeHandle, Captures>,
  adapter: JsonAdapter,
  options: JsonMountOptions = {},
): Query<NavigableNodeHandle, Captures> =>
  files.project(
    (file) => mountedFilesystemHandle(file, adapter, options.onError ?? "skip"),
    "mount json",
  );

export const mountJsonTextHandle = (
  container: NavigableNodeHandle,
  adapter: JsonAdapter,
  source: JsonTextMountSource,
  options: JsonMountOptions = {},
): NavigableNodeHandle =>
  Object.freeze({
    snapshot: container.snapshot,
    edges(request: EdgeRequest = {}) {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const edge of container.edges(request)) yield edge;
          if (!requested(request, "json::mount", "child")) return;
          const internals = adapterInternals.get(adapter);
          if (internals === undefined) throw new TypeError("Unknown JSON adapter instance.");
          const handle = await internals.openTextMounted(
            container.snapshot,
            source,
            request.signal === undefined ? {} : { signal: request.signal },
            options.onError ?? "skip",
          );
          if (handle === undefined) return;
          try {
            for await (const root of adapter.read.roots(handle.resource, request)) {
              yield defineEdge({
                name: "json::mount",
                role: "child",
                from: container.snapshot.id,
                to: root.id,
                ordinal: 0,
              });
            }
          } finally {
            await handle.close();
          }
        },
      };
    },
    async resolve(id: NodeId, signal?: AbortSignal) {
      if (id.adapter !== "json") return container.resolve(id, signal);
      const [resolved] = await adapter.read.hydrate([id], {
        attributes: [],
        ...(signal === undefined ? {} : { signal }),
      });
      return resolved === undefined
        ? undefined
        : mountedJsonHandle(adapter, resolved, container);
    },
  });

export const createJsonAdapter = (): JsonAdapter => {
  const resources = new Map<string, ResourceState>();
  const diagnostics: Diagnostic[] = [];
  const statistics: MutableStatistics = {
    opened: 0,
    closed: 0,
    filesRead: 0,
    bytesRead: 0,
    parses: 0,
  };

  const stateFor = (resource: Resource | string): ResourceState => {
    const id = typeof resource === "string" ? resource : resource.id;
    const state = resources.get(id);
    if (state === undefined) throw new TypeError(`Unknown JSON resource ${id}.`);
    return state;
  };

  const recordSyntaxFailure = (
    uri: string,
    text: string,
    failure: JsonSyntaxFailure,
  ): Diagnostic => {
    const start = Math.min(failure.offset, text.length);
    const end = Math.min(text.length, start + 1);
    const diagnostic = defineDiagnostic({
      code: "json.invalid-syntax",
      severity: "error",
      message: `Cannot parse ${uri}: ${failure.message}`,
      locations: [
        {
          kind: "source",
          origin: { uri, range: sourceRange(text, start, end) },
        },
        { kind: "adapter", adapter: "json" },
      ],
    });
    diagnostics.push(diagnostic);
    return diagnostic;
  };

  const recordRevisionConflict = (
    container: NodeSnapshot,
    actualRevision: Revision,
  ): Diagnostic => {
    const diagnostic = defineDiagnostic({
      code: "json.revision-conflict",
      severity: "error",
      message: `Cannot mount ${container.origin?.uri ?? "JSON source"}: the file changed after filesystem observation.`,
      locations: [
        {
          kind: "node",
          node: container.id,
          ...(container.origin === undefined ? {} : { origin: container.origin }),
        },
        {
          kind: "source",
          origin: {
            uri: container.origin?.uri ?? "json:unknown",
            revision: actualRevision,
          },
        },
      ],
    });
    diagnostics.push(diagnostic);
    return diagnostic;
  };

  const load = async (
    uri: string,
    container: NodeSnapshot | undefined,
    context: OpenContext,
    onError: "skip" | "throw",
  ): Promise<ResourceHandle | undefined> => {
    throwIfAborted(context.signal);
    statistics.opened += 1;
    const path = sourcePath(uri);
    let closed = false;
    const close = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        statistics.closed += 1;
      }
    };
    try {
      const before = await lstat(path);
      throwIfAborted(context.signal);
      const buffer = await readFile(path);
      statistics.filesRead += 1;
      statistics.bytesRead += buffer.byteLength;
      throwIfAborted(context.signal);
      const after = await lstat(path);
      const revision = revisionOf(after);
      if (revisionOf(before) !== revision) {
        throw new Error("JSON source changed while it was being read.");
      }
      if (
        container?.origin?.revision !== undefined &&
        container.origin.revision !== revision
      ) {
        const diagnostic = recordRevisionConflict(container, revision);
        await close();
        if (onError === "throw") throw new Error(diagnostic.message);
        return undefined;
      }
      if (
        (buffer[0] === 0xff && buffer[1] === 0xfe) ||
        (buffer[0] === 0xfe && buffer[1] === 0xff) ||
        (buffer[0] === 0x00 && buffer[1] !== undefined) ||
        (buffer[1] === 0x00 && buffer[0] !== undefined)
      ) {
        const failure = new JsonSyntaxFailure("Only UTF-8 JSON documents are supported.", 0);
        const diagnostic = recordSyntaxFailure(uri, "", failure);
        await close();
        if (onError === "throw") throw new Error(diagnostic.message);
        return undefined;
      }
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
      } catch (error) {
        const failure = new JsonSyntaxFailure("Document is not valid UTF-8.", 0);
        const diagnostic = recordSyntaxFailure(uri, "", failure);
        await close();
        if (onError === "throw") throw new Error(diagnostic.message, { cause: error });
        return undefined;
      }
      const bom = decoded.startsWith("\uFEFF");
      const text = bom ? decoded.slice(1) : decoded;
      statistics.parses += 1;
      let rootSyntax: JsonSyntax;
      try {
        rootSyntax = new JsonParser(text).parse();
      } catch (error) {
        if (!(error instanceof JsonSyntaxFailure)) throw error;
        const diagnostic = recordSyntaxFailure(uri, text, error);
        await close();
        if (onError === "throw") throw new Error(diagnostic.message, { cause: error });
        return undefined;
      }
      const resource = defineResource({
        id: resourceKey(uri, container),
        adapter: "json",
        uri,
        revision,
      });
      const finalNewline = /[\r\n]$/u.test(text);
      const newline = text.includes("\r\n")
        ? "\r\n"
        : text.includes("\n")
          ? "\n"
          : text.includes("\r")
            ? "\r"
            : "\n";
      const state: ResourceState = Object.freeze({
        resource,
        path,
        text,
        bom,
        finalNewline,
        newline,
        indent: inferIndent(text),
        rootSyntax,
        nodes: buildNodeRecords(resource, text, rootSyntax, bom, finalNewline),
        ...(container === undefined ? {} : { container }),
      });
      resources.set(resource.id, state);
      return Object.freeze({ resource, close });
    } catch (error) {
      await close();
      throw error;
    }
  };

  const loadText = async (
    container: NodeSnapshot,
    source: JsonTextMountSource,
    context: OpenContext,
    onError: "skip" | "throw",
  ): Promise<ResourceHandle | undefined> => {
    throwIfAborted(context.signal);
    statistics.opened += 1;
    statistics.bytesRead += Buffer.byteLength(source.text);
    statistics.parses += 1;
    let closed = false;
    const close = async (): Promise<void> => {
      if (!closed) {
        closed = true;
        statistics.closed += 1;
      }
    };
    const bom = source.text.startsWith("\uFEFF");
    const text = bom ? source.text.slice(1) : source.text;
    let rootSyntax: JsonSyntax;
    try {
      rootSyntax = new JsonParser(text).parse();
    } catch (error) {
      if (!(error instanceof JsonSyntaxFailure)) {
        await close();
        throw error;
      }
      const diagnostic = recordSyntaxFailure(source.uri, text, error);
      await close();
      if (onError === "throw") throw new Error(diagnostic.message, { cause: error });
      return undefined;
    }
    const revision = source.revision ?? createHash("sha256").update(source.text).digest("base64url");
    const resource = defineResource({
      id: resourceKey(source.uri, container),
      adapter: "json",
      uri: source.uri,
      revision,
    });
    const finalNewline = /[\r\n]$/u.test(text);
    const newline = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
    const state: ResourceState = Object.freeze({
      resource,
      text,
      bom,
      finalNewline,
      newline,
      indent: inferIndent(text),
      rootSyntax,
      nodes: buildNodeRecords(resource, text, rootSyntax, bom, finalNewline),
      container,
    });
    resources.set(resource.id, state);
    return Object.freeze({ resource, close });
  };

  const read: ReadCapability = {
    async open(source: SourceDescriptor, context: OpenContext): Promise<ResourceHandle> {
      if (source.uri.length === 0) throw new TypeError("JSON source URI must not be empty.");
      const uri = pathToFileURL(sourcePath(source.uri)).href;
      const handle = await load(uri, undefined, context, "throw");
      if (handle === undefined) throw new Error(`Cannot open JSON source ${uri}.`);
      return handle;
    },

    roots(resource: Resource, request: RootRequest): AsyncIterable<NodeSnapshot> {
      return {
        async *[Symbol.asyncIterator]() {
          throwIfAborted(request.signal);
          const root = stateFor(resource).nodes.get("$");
          if (root !== undefined) yield root.snapshot;
        },
      };
    },

    edges(node: NodeId, request: EdgeRequest): AsyncIterable<Edge> {
      return {
        async *[Symbol.asyncIterator]() {
          throwIfAborted(request.signal);
          if (node.adapter !== "json") return;
          const state = stateFor(node.resource);
          const record = state.nodes.get(node.local);
          if (record === undefined) return;
          const direction = request.direction ?? "forward";
          const wantsChildren =
            (request.names === undefined || request.names.includes("json::children")) &&
            (request.roles === undefined || request.roles.includes("child"));
          const wantsContainer =
            (request.names === undefined || request.names.includes("json::container")) &&
            (request.roles === undefined || request.roles.includes("reference"));

          if (direction === "forward") {
            if (wantsChildren) {
              for (const [ordinal, childLocal] of record.childLocals.entries()) {
                throwIfAborted(request.signal);
                const child = state.nodes.get(childLocal);
                if (child === undefined) continue;
                yield defineEdge({
                  name: "json::children",
                  role: "child",
                  from: record.snapshot.id,
                  to: child.snapshot.id,
                  ordinal,
                });
              }
            }
            if (node.local === "$" && wantsContainer && state.container !== undefined) {
              yield defineEdge({
                name: "json::container",
                role: "reference",
                from: record.snapshot.id,
                to: state.container.id,
                ordinal: 0,
              });
            }
            return;
          }

          if (wantsChildren && record.parent !== undefined) {
            const parent = state.nodes.get(record.parent);
            if (parent !== undefined) {
              yield defineEdge({
                name: "json::children",
                role: "child",
                from: parent.snapshot.id,
                to: record.snapshot.id,
                ordinal: parent.childLocals.indexOf(node.local),
              });
            }
          }
        },
      };
    },

    async hydrate(
      ids: readonly NodeId[],
      projection: AttributeProjection,
    ): Promise<readonly NodeSnapshot[]> {
      const hydrated: NodeSnapshot[] = [];
      for (const id of ids) {
        throwIfAborted(projection.signal);
        if (id.adapter !== "json") continue;
        const record = resources.get(id.resource)?.nodes.get(id.local);
        if (record !== undefined) hydrated.push(record.snapshot);
      }
      return Object.freeze(hydrated);
    },
  };

  const planning: PlanningCapability<JsonOperation, JsonChange> = {
    async plan(operation, context) {
      throwIfAborted(context.signal);
      const state = stateFor(operation.resource);
      const record = state.nodes.get(operation.target.local);
      if (record === undefined || operation.target.adapter !== "json") {
        throw new TypeError(`Unknown JSON operation target ${operation.target.local}.`);
      }
      if (state.path === undefined) {
        throw new TypeError("Embedded JSON mounts are read-only; edit their containing document.");
      }
      const actualRevision = revisionOf(await lstat(state.path));
      throwIfAborted(context.signal);
      if (
        actualRevision !== state.resource.revision ||
        (operation.expectedRevision !== undefined &&
          operation.expectedRevision !== actualRevision)
      ) {
        diagnostics.push(
          defineDiagnostic({
            code: "json.revision-conflict",
            severity: "error",
            message: `JSON source ${state.resource.uri} changed after it was observed.`,
            locations: [
              {
                kind: "node",
                node: operation.target,
                ...(record.snapshot.origin === undefined
                  ? {}
                  : { origin: record.snapshot.origin }),
              },
              { kind: "operation", operation: operation.kind },
            ],
          }),
        );
        return [];
      }

      let payload: JsonPatchPayload;
      let risk: JsonChange["risk"];
      let summary: string;
      if (operation.kind === "json::replace-value") {
        payload = replacePatch(state, record, operation.payload.value);
        risk = "destructive";
        summary = `Replace JSON value at ${operation.target.local}`;
      } else if (operation.kind === "json::insert-property") {
        payload = insertPropertyPatch(
          state,
          record,
          operation.payload.name,
          operation.payload.value,
        );
        risk = "safe";
        summary = `Insert JSON property ${JSON.stringify(operation.payload.name)}`;
      } else if (operation.kind === "json::remove-property") {
        payload = removePropertyPatch(state, record);
        risk = "destructive";
        summary = `Remove JSON property ${String(record.snapshot.attributes.name)}`;
      } else if (operation.kind === "json::insert-array-item") {
        payload = insertArrayItemPatch(
          state,
          record,
          operation.payload.index,
          operation.payload.value,
        );
        risk = "safe";
        summary = `Insert JSON array item at index ${operation.payload.index}`;
      } else {
        payload = removeArrayItemPatch(state, record);
        risk = "destructive";
        summary = `Remove JSON array item at index ${String(record.snapshot.attributes.index)}`;
      }
      const precondition: JsonPrecondition = Object.freeze({
        resource: state.resource.id,
        uri: state.resource.uri,
        expectedRevision: actualRevision,
        expectation: "exists",
        description: "JSON source must retain its observed filesystem revision.",
      });
      const change: JsonChange = immutableCopy({
        adapter: "json",
        resource: state.resource.id,
        resourceUri: state.resource.uri,
        resourceRevision: actualRevision,
        kind: operation.kind,
        risk,
        summary,
        reversible: true,
        payload,
        preconditions: [precondition],
        regions: [{ uri: state.resource.uri, range: payload.range }],
        preview: {
          kind: "text",
          uri: state.resource.uri,
          before: payload.original,
          after: payload.content,
          sensitive: true,
        },
        transaction: {
          key: state.resource.uri,
          atomic: true,
          rollback: "none",
          compensation: "none",
        },
      });
      return Object.freeze([change]);
    },
  };

  const apply: ApplyCapability<JsonChange, ApplyResult> = {
    async apply(changes, context) {
      throwIfAborted(context.signal);
      if (changes.length === 0) {
        return Object.freeze({ applied: 0, diagnostics: Object.freeze([]) });
      }
      const first = changes[0];
      if (first === undefined) throw new TypeError("JSON apply group is empty.");
      if (
        changes.some(
          (change) =>
            change.resource !== first.resource ||
            change.payload.uri !== first.payload.uri ||
            change.payload.original !== first.payload.original,
        )
      ) {
        throw new TypeError("Atomic JSON changes must share one observed document.");
      }
      const path = fileURLToPath(first.payload.uri);
      const stat = await lstat(path);
      const actualRevision = revisionOf(stat);
      for (const change of changes) {
        for (const precondition of change.preconditions) {
          if (
            precondition.expectation !== "exists" ||
            precondition.expectedRevision !== actualRevision
          ) {
            throw new Error(`JSON revision changed for ${precondition.uri}.`);
          }
        }
      }
      const current = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(await readFile(path));
      if (current !== first.payload.original) {
        throw new Error(`JSON content changed for ${first.payload.uri}.`);
      }
      const bom = current.startsWith("\uFEFF");
      let text = bom ? current.slice(1) : current;
      const ordered = [...changes].toSorted(
        (left, right) => right.payload.range.start - left.payload.range.start,
      );
      let previousStart = Number.POSITIVE_INFINITY;
      for (const change of ordered) {
        const { start, end } = change.payload.range;
        if (end > previousStart) throw new Error("JSON change patches overlap.");
        text = `${text.slice(0, start)}${change.payload.replacement}${text.slice(end)}`;
        previousStart = start;
      }
      throwIfAborted(context.signal);
      const temporary = join(dirname(path), `.${basename(path)}.ast-${randomUUID()}`);
      try {
        await writeFile(temporary, `${bom ? "\uFEFF" : ""}${text}`, { mode: stat.mode });
        throwIfAborted(context.signal);
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return Object.freeze({
        applied: changes.length,
        diagnostics: Object.freeze([]),
      });
    },
  };

  const adapter: JsonAdapter = Object.freeze({
    namespace: "json",
    schema,
    read,
    planning,
    apply,
    diagnostics: () => Object.freeze([...diagnostics]),
    statistics: () => Object.freeze({ ...statistics }),
  });
  adapterInternals.set(adapter, {
    async openMounted(container, context, onError) {
      if (container.id.adapter !== "fs" || container.kind !== "fs::file") {
        throw new TypeError("JSON mounts require an fs::file container.");
      }
      const uri = container.origin?.uri;
      if (uri === undefined) throw new TypeError("Mounted filesystem files require an origin URI.");
      return load(uri, container, context, onError);
    },
    openTextMounted(container, source, context, onError) {
      return loadText(container, source, context, onError);
    },
  });
  return adapter;
};
