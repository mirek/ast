import type {
  AdapterSchema,
  ApplyCapability,
  DynamicAdapterSchema,
  NodeSnapshot,
  PlanningCapability,
  ReadCapability,
} from "../src/index.js";

const syntheticNode: NodeSnapshot = {
  id: { adapter: "memory", resource: "fixture", local: "derived" },
  kind: "memory::derived",
  attributes: {},
};
void syntheticNode;

// @ts-expect-error node kinds must retain their adapter namespace
const ambiguousNode: NodeSnapshot = { ...syntheticNode, kind: "derived" };
void ambiguousNode;

declare const reader: ReadCapability;
// @ts-expect-error read access never implies planning access
const planner: PlanningCapability = reader;
// @ts-expect-error read access never implies apply access
const applier: ApplyCapability = reader;
void planner;
void applier;

const dynamicSchema: DynamicAdapterSchema = {
  namespace: "plugin",
  version: "unversioned-runtime-schema",
  dynamic: true,
  kinds: [],
  edges: [],
  operations: [],
  treeViews: [],
  capabilities: {
    traversal: [],
    pushdown: [],
    ordering: "unknown",
    revisions: false,
    transactions: "none",
  },
};

const schema: AdapterSchema = dynamicSchema;
void schema;
