import { immutableCopy } from "./immutable.js";
import {
  assertNamespace,
  assertNamespacedName,
  type EdgeName,
  type EdgeRole,
  type NamespacedName,
  type NodeKind,
  type OperationKind,
} from "./model.js";

export type ScalarType = "string" | "number" | "boolean" | "bigint" | "null";
export type Cardinality = "one" | "many";

export interface AttributeSchema {
  readonly scalar: ScalarType | readonly ScalarType[];
  readonly cardinality: Cardinality;
  readonly required: boolean;
  readonly sensitive?: boolean;
}

export interface IdentityGuarantee {
  readonly stability: "observation" | "revision" | "persistent";
  readonly description: string;
}

export interface NodeKindSchema {
  readonly kind: NodeKind;
  readonly attributes: Readonly<Record<string, AttributeSchema>>;
  readonly identity: IdentityGuarantee;
}

export interface EdgeSchema {
  readonly name: EdgeName;
  readonly role: EdgeRole;
  readonly from: readonly NodeKind[];
  readonly to: readonly NodeKind[];
  readonly ordering: "stable" | "unknown";
}

export interface OperationArgumentSchema {
  readonly type: ScalarType | "node-id" | "unknown";
  readonly cardinality: Cardinality;
  readonly required: boolean;
}

export interface OperationSchema {
  readonly kind: OperationKind;
  readonly arguments: Readonly<Record<string, OperationArgumentSchema>>;
}

export interface TreeViewSchema {
  readonly name: NamespacedName;
  readonly rootKinds: readonly NodeKind[];
  readonly childEdges: readonly EdgeName[];
  readonly default?: boolean;
}

export type TraversalCapability = "tree" | "reference";
export type PushdownCapability =
  | "predicate"
  | "projection"
  | "sort"
  | "aggregation"
  | "join"
  | "offset"
  | "limit";

export interface AdapterCapabilities {
  readonly traversal: readonly TraversalCapability[];
  readonly pushdown: readonly PushdownCapability[];
  readonly ordering: "stable" | "unknown";
  readonly revisions: boolean;
  readonly transactions: "none" | "local" | "distributed";
  readonly watch?: boolean;
  readonly semanticOperations?: boolean;
  readonly rollback?: boolean;
  readonly compensation?: boolean;
  readonly parallelReads?: boolean;
  readonly parallelWrites?: boolean;
}

interface AdapterSchemaFields {
  readonly namespace: string;
  readonly version: string;
  readonly kinds: readonly NodeKindSchema[];
  readonly edges: readonly EdgeSchema[];
  readonly operations: readonly OperationSchema[];
  readonly treeViews: readonly TreeViewSchema[];
  readonly capabilities: AdapterCapabilities;
}

export interface StaticAdapterSchema extends AdapterSchemaFields {
  readonly dynamic: false;
}

export interface DynamicAdapterSchema extends AdapterSchemaFields {
  readonly dynamic: true;
}

export type AdapterSchema = StaticAdapterSchema | DynamicAdapterSchema;

const namespaceOf = (name: NamespacedName): string => name.slice(0, name.indexOf("::"));

const assertOwnedName = (
  namespace: string,
  label: string,
  value: NamespacedName,
): void => {
  assertNamespacedName(value);
  if (namespaceOf(value) !== namespace) {
    throw new TypeError(`${label} ${value} does not belong to namespace ${namespace}.`);
  }
};

const assertUnique = (label: string, values: readonly string[]): void => {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} names must be unique.`);
  }
};

const validateSchema = (schema: AdapterSchema): void => {
  assertNamespace(schema.namespace);
  if (schema.version.length === 0) throw new TypeError("Schema version must not be empty.");

  for (const kind of schema.kinds) {
    assertOwnedName(schema.namespace, "Node kind", kind.kind);
  }
  for (const edge of schema.edges) {
    assertOwnedName(schema.namespace, "Edge", edge.name);
    for (const kind of [...edge.from, ...edge.to]) assertNamespacedName(kind);
  }
  for (const operation of schema.operations) {
    assertOwnedName(schema.namespace, "Operation", operation.kind);
  }
  for (const tree of schema.treeViews) {
    assertOwnedName(schema.namespace, "Tree view", tree.name);
    for (const kind of tree.rootKinds) assertNamespacedName(kind);
    for (const edge of tree.childEdges) assertNamespacedName(edge);
  }

  assertUnique("Node kind", schema.kinds.map(({ kind }) => kind));
  assertUnique("Edge", schema.edges.map(({ name }) => name));
  assertUnique("Operation", schema.operations.map(({ kind }) => kind));
  assertUnique("Tree view", schema.treeViews.map(({ name }) => name));

  if (schema.treeViews.filter((tree) => tree.default === true).length > 1) {
    throw new TypeError("An adapter schema can define at most one default tree view.");
  }
};

export const defineAdapterSchema = <const T extends AdapterSchema>(value: T): T => {
  validateSchema(value);
  return immutableCopy(value);
};
