import { immutableCopy } from "./immutable.js";

export type Scalar = string | number | boolean | bigint | null;
export type AttributeValue = Scalar | readonly Scalar[];
export type NamespacedName = `${string}::${string}`;
export type NodeKind = NamespacedName;
export type EdgeName = NamespacedName;
export type OperationKind = NamespacedName;
export type Revision = string;

export interface NodeId {
  readonly adapter: string;
  readonly resource: string;
  readonly local: string;
}

export interface SourceRange {
  readonly start: number;
  readonly end: number;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface Origin {
  readonly uri: string;
  readonly revision?: Revision;
  readonly range?: SourceRange;
}

export interface NodeSnapshot {
  readonly id: NodeId;
  readonly kind: NodeKind;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly origin?: Origin;
}

export type EdgeRole = "child" | "reference";

export interface Edge {
  readonly name: EdgeName;
  readonly role: EdgeRole;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly ordinal?: number;
  readonly attributes?: Readonly<Record<string, Scalar>>;
}

export interface Resource {
  readonly id: string;
  readonly adapter: string;
  readonly uri: string;
  readonly revision?: Revision;
}

export type SelectionOrdering = "stable" | "unknown";

export interface Selection<T> extends AsyncIterable<T> {
  readonly ordering: SelectionOrdering;
}

export interface NodeHandle {
  readonly snapshot: NodeSnapshot;
  edges(request?: EdgeRequest): AsyncIterable<Edge>;
}

export interface EdgeRequest {
  readonly names?: readonly EdgeName[];
  readonly roles?: readonly EdgeRole[];
  readonly direction?: "forward" | "reverse";
  readonly signal?: AbortSignal;
}

const namespacePattern = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const namespacedNamePattern =
  /^[A-Za-z][A-Za-z0-9._-]*::[A-Za-z][A-Za-z0-9._-]*$/u;

export const assertNamespace = (value: string): void => {
  if (!namespacePattern.test(value)) {
    throw new TypeError(`Expected a valid namespace, received ${JSON.stringify(value)}.`);
  }
};

export function assertNamespacedName(
  value: string,
): asserts value is NamespacedName {
  if (!namespacedNamePattern.test(value)) {
    throw new TypeError(
      `Expected a namespaced name such as "adapter::name", received ${JSON.stringify(value)}.`,
    );
  }
}

const assertNonEmpty = (label: string, value: string): void => {
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
};

const assertNodeId = (id: NodeId): void => {
  assertNamespace(id.adapter);
  assertNonEmpty("Resource identifier", id.resource);
  assertNonEmpty("Local node identifier", id.local);
};

const assertOffset = (label: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
};

const assertRange = (range: SourceRange): void => {
  assertOffset("Source range start", range.start);
  assertOffset("Source range end", range.end);
  if (range.end < range.start) {
    throw new RangeError("Invalid source range: end precedes start.");
  }

  const positions = [
    ["Source start line", range.startLine],
    ["Source start column", range.startColumn],
    ["Source end line", range.endLine],
    ["Source end column", range.endColumn],
  ] as const;
  for (const [label, position] of positions) {
    if (position !== undefined) assertOffset(label, position);
  }
};

const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  typeof value === "bigint";

const assertAttributes = (
  attributes: Readonly<Record<string, AttributeValue>>,
): void => {
  for (const [name, value] of Object.entries(attributes)) {
    assertNonEmpty("Attribute name", name);
    if (Array.isArray(value)) {
      if (!value.every(isScalar)) {
        throw new TypeError(`Attribute ${JSON.stringify(name)} contains a non-scalar value.`);
      }
    } else if (!isScalar(value)) {
      throw new TypeError(`Attribute ${JSON.stringify(name)} is not scalar.`);
    }
  }
};

export const defineNodeSnapshot = <const T extends NodeSnapshot>(value: T): T => {
  assertNodeId(value.id);
  assertNamespacedName(value.kind);
  if (!value.kind.startsWith(`${value.id.adapter}::`)) {
    throw new TypeError(
      `Node kind ${value.kind} does not belong to node adapter ${value.id.adapter}.`,
    );
  }
  assertAttributes(value.attributes);
  if (value.origin !== undefined) {
    assertNonEmpty("Origin URI", value.origin.uri);
    if (value.origin.range !== undefined) assertRange(value.origin.range);
  }
  return immutableCopy(value);
};

export const defineEdge = <const T extends Edge>(value: T): T => {
  assertNamespacedName(value.name);
  assertNodeId(value.from);
  assertNodeId(value.to);
  if (value.ordinal !== undefined) assertOffset("Edge ordinal", value.ordinal);
  if (value.attributes !== undefined) assertAttributes(value.attributes);
  return immutableCopy(value);
};

export const defineResource = <const T extends Resource>(value: T): T => {
  assertNonEmpty("Resource identifier", value.id);
  assertNamespace(value.adapter);
  assertNonEmpty("Resource URI", value.uri);
  return immutableCopy(value);
};
