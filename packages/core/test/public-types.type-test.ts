import type {
  AdapterSchema,
  AdapterCompatibility,
  ChangePlan,
  ApplyCapability,
  DynamicAdapterSchema,
  DslEnvironment,
  DslArgumentSchema,
  DslArguments,
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
  SelectorSourceMode,
  SqlAdapter,
  SqlCatalog,
  SqlClient,
  SqlMutationTarget,
  SqlRowSource,
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
  defineDslArgumentSchema,
  mountJson,
  mountMarkdown,
  mountTypeScript,
  planOperations,
  project,
  registerPlugins,
  selectFrom,
  fromSqlRows,
  sqlUpdateRows,
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
const selectorSourceMode: SelectorSourceMode = "selection";
const filesystemSelection = selectFrom(
  filesystemQuery,
  createFilesystemAdapter().schema,
  "fs::file",
  { sourceMode: selectorSourceMode },
);
void filesystemSelection;
const dslEnvironment: DslEnvironment = {
  sources: {
    fs: {
      adapter: createFilesystemAdapter(),
      selectorSource: selectorSourceMode,
      arguments: {
        uri: { type: "string", cardinality: "one", required: true },
      },
      open: () => filesystemQuery,
    },
  },
};
void dslEnvironment;
const dslArgumentSchema: DslArgumentSchema = defineDslArgumentSchema({
  uri: { type: "string", cardinality: "one", required: true },
  include: { type: "string", cardinality: "many", required: false },
});
const dslArguments: DslArguments = {
  uri: ".",
  include: ["**/*.ts"],
};
void dslArgumentSchema;
void dslArguments;
const observedFilesystem = createFilesystemAdapter({ clock: () => 0 });
const filesystemIoDuration: number = observedFilesystem.statistics().ioDurationMs;
void filesystemIoDuration;

declare const filesystemChange: FilesystemChange;
const filesystemChangeKind: "fs::write" | "fs::move" | "fs::remove" | "fs::create" =
  filesystemChange.kind;
void filesystemChangeKind;

const jsonValue: JsonValue = { name: "ast", values: [true, null, 1] };
const json = createJsonAdapter();
const mountedJson = mountJson(filesystemQuery, json);
const mountedJsonSelection = selectFrom(
  mountedJson,
  [createFilesystemAdapter().schema, json.schema],
  "fs::file > json::root",
);
void mountedJsonSelection;

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
const mountedMarkdown = mountMarkdown(filesystemQuery, markdown, {
  treeView: "markdown::section-tree",
});
void mountedMarkdown;

declare const markdownChange: MarkdownChange;
const markdownKind: "markdown::set-heading" | "markdown::replace-section" =
  markdownChange.kind;
void markdownKind;

const typescript = createTypeScriptAdapter({ project: "tsconfig.json" });
const typeScriptMode: "syntax-only" | "configured-project" = typescript.mode;
void typeScriptMode;
const typeScriptProject: string | undefined = typescript.project;
void typeScriptProject;
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

declare const sqlAdapter: SqlAdapter;
declare const sqlClient: SqlClient;
const sqlCatalog: SqlCatalog = {
  server: "local",
  database: "app",
  version: "catalog:1",
  schemas: [],
};
void sqlCatalog;
void sqlClient;
const sqlSource: SqlRowSource = {
  table: { schema: "public", name: "users" },
  where: { kind: "comparison", column: "id", operator: "=", value: 1 },
};
const sqlQuery = fromSqlRows(sqlAdapter, sqlSource);
void sqlQuery;
const sqlTarget: SqlMutationTarget = {
  resource: "app",
  table: sqlSource.table,
  where: { kind: "comparison", column: "id", operator: "=", value: 1 },
  concurrency: { kind: "transaction" },
};
const sqlOperation = sqlUpdateRows(sqlAdapter, sqlTarget, { name: "updated" });
void sqlOperation;
