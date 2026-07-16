import type {
  AdapterSchema,
  ChangePlan,
  ApplyCapability,
  DynamicAdapterSchema,
  FilesystemChange,
  FilesystemSource,
  FilesystemWriteOperation,
  JsonChange,
  JsonValue,
  NodeSnapshot,
  PlanningCapability,
  ReadCapability,
} from "../src/index.js";
import {
  capture,
  applyChangePlan,
  createFilesystemAdapter,
  createJsonAdapter,
  fromFilesystem,
  fromValues,
  jsonReplaceValue,
  mountJson,
  planOperations,
  project,
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

const captured = capture(fromValues([1, 2]), "original");
const projected = project(captured, (value, captures) => value + captures.original);
void projected;

project(fromValues([1, 2]), (value, captures) => {
  // @ts-expect-error captures enter scope only after an explicit capture operator
  return value + captures.original;
});

const filesystemSource: FilesystemSource = {
  uri: ".",
  include: ["**/*.ts"],
  kinds: ["fs::file"],
};
const filesystemQuery = fromFilesystem(createFilesystemAdapter(), filesystemSource);
void filesystemQuery;

declare const filesystemChange: FilesystemChange;
const filesystemChangeKind: "fs::write" | "fs::move" | "fs::remove" | "fs::create" =
  filesystemChange.kind;
void filesystemChangeKind;

const jsonValue: JsonValue = { name: "ast", values: [true, null, 1] };
const json = createJsonAdapter();
const mountedJson = mountJson(filesystemQuery, json);
void mountedJson;

declare const jsonNode: NodeSnapshot;
const jsonOperation = jsonReplaceValue(jsonNode, jsonValue);
void jsonOperation;

declare const jsonChange: JsonChange;
const jsonChangeKind:
  | "json::replace-value"
  | "json::insert-property"
  | "json::remove-property"
  | "json::insert-array-item"
  | "json::remove-array-item" = jsonChange.kind;
void jsonChangeKind;

declare const changePlan: ChangePlan;
const applyPromise = applyChangePlan(changePlan, [createFilesystemAdapter()]);
void applyPromise;

declare const filesystemOperation: FilesystemWriteOperation;
const planned = planOperations([
  {
    id: "write",
    adapter: createFilesystemAdapter(),
    operation: filesystemOperation,
  },
]);
void planned;
