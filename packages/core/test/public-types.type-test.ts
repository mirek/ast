import type {
  AdapterSchema,
  AdapterCompatibility,
  ChangePlan,
  ApplyCapability,
  DynamicAdapterSchema,
  FilesystemChange,
  FilesystemSource,
  FilesystemWriteOperation,
  JsonChange,
  JsonValue,
  MarkdownChange,
  MarkdownSource,
  TypeScriptChange,
  NodeSnapshot,
  PlanningCapability,
  PluginManifest,
  PluginPolicy,
  PluginPower,
  PluginRegistry,
  ReadCapability,
} from "../src/index.js";
import {
  capture,
  adapterCompatibility,
  applyChangePlan,
  createFilesystemAdapter,
  createJsonAdapter,
  createMarkdownAdapter,
  createTypeScriptAdapter,
  fromFilesystem,
  fromValues,
  jsonReplaceValue,
  mountJson,
  mountMarkdown,
  mountTypeScript,
  planOperations,
  project,
  registerPlugins,
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

const markdown = createMarkdownAdapter({ json });
const markdownSource: MarkdownSource = {
  uri: "README.md",
  treeView: "markdown::section-tree",
};
void markdownSource;
const mountedMarkdown = mountMarkdown(filesystemQuery, markdown);
void mountedMarkdown;

declare const markdownChange: MarkdownChange;
const markdownKind: "markdown::set-heading" | "markdown::replace-section" =
  markdownChange.kind;
void markdownKind;

const typescript = createTypeScriptAdapter({ project: "tsconfig.json" });
const mountedTypeScript = mountTypeScript(filesystemQuery, typescript);
void mountedTypeScript;
declare const typeScriptChange: TypeScriptChange;
const typeScriptKind: "ts::rename-symbol" | "ts::replace-call" = typeScriptChange.kind;
void typeScriptKind;

const compatibility: AdapterCompatibility = adapterCompatibility(typescript);
const contractVersion: "1" = compatibility.contractVersion;
void contractVersion;

const pluginPower: PluginPower = "filesystem:read";
const pluginManifest: PluginManifest = {
  apiVersion: "1",
  name: "@example/plugin",
  version: "1.0.0",
  integrity: "sha256:build",
  namespaces: ["example"],
  powers: [pluginPower],
  contributions: {
    adapters: [], schemas: [], resolvers: [], mounts: [], operations: [],
    predicates: [], functions: [], renderers: [], diffProviders: [], optimizerRules: [],
  },
};
void pluginManifest;
const pluginPolicy: PluginPolicy = { allow: [] };
const pluginRegistry: PluginRegistry = registerPlugins([], pluginPolicy);
void pluginRegistry;
