import { closeQueryResource } from "./buffering.js";
import { mountParentEdges } from "./mount.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

import type { Adapter, ApplyCapability, ApplyResult, AttributeProjection, MountCapability, OpenContext, Operation, PlanningCapability, ReadCapability, ResourceHandle, RootRequest, SourceDescriptor } from "./adapter.js";
import type { Change, ChangePrecondition, ChangeRegion, ChangeTransaction, TextChangePreview } from "./change.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import { defineEdge, defineNodeSnapshot, defineResource } from "./model.js";
import type { EdgeRequest, NodeId, NodeSnapshot, Resource, Revision, SourceRange } from "./model.js";
import type { CaptureMap, NavigableNodeHandle, Query } from "./query.js";
import { defineAdapterSchema } from "./schema.js";
import type { NodeKindSchema } from "./schema.js";
import { moduleInfoFor } from "./typescript-module.js";
import type { TypeScriptModuleInfo } from "./typescript-module.js";

export type TypeScriptNodeKind = "ts::source-file" | "ts::function" | "ts::class" | "ts::variable" | "ts::call" | "ts::identifier" | "ts::import" | "ts::node";
export type TypeScriptOperationKind = "ts::rename-symbol" | "ts::replace-call";

export interface TypeScriptAdapterOptions { readonly project?: string; }
interface TsOperation<Kind extends TypeScriptOperationKind, Payload> extends Operation<Kind, Payload> { readonly target: NodeId; readonly expectedRevision?: Revision; }
export type TypeScriptRenameSymbolOperation = TsOperation<"ts::rename-symbol", { readonly name: string }>;
export type TypeScriptReplaceCallOperation = TsOperation<"ts::replace-call", { readonly callee: string }>;
export type TypeScriptOperation = TypeScriptRenameSymbolOperation | TypeScriptReplaceCallOperation;
export interface TypeScriptPrecondition extends ChangePrecondition { readonly expectedRevision: Revision; }
export interface TypeScriptPatch { readonly range: SourceRange; readonly replacement: string; }
export interface TypeScriptPatchPayload { readonly uri: string; readonly original: string; readonly content: string; readonly patches: readonly TypeScriptPatch[]; }
export interface TypeScriptChange extends Change<TypeScriptPatchPayload> {
  readonly adapter: "ts";
  readonly kind: TypeScriptOperationKind;
  readonly risk: "destructive";
  readonly reversible: true;
  readonly preconditions: readonly TypeScriptPrecondition[];
  readonly regions: readonly ChangeRegion[];
  readonly preview: TextChangePreview;
  readonly transaction: ChangeTransaction;
}
export interface TypeScriptStatistics { readonly programsCreated: number; readonly sourceFilesParsed: number; readonly nodesProjected: number; readonly opened: number; readonly closed: number; }
export interface TypeScriptAdapter extends Adapter {
  readonly namespace: "ts";
  readonly mode: "syntax-only" | "configured-project";
  readonly project?: string;
  readonly read: ReadCapability;
  readonly planning: PlanningCapability<TypeScriptOperation, TypeScriptChange>;
  readonly apply: ApplyCapability<TypeScriptChange, ApplyResult>;
  readonly mount: MountCapability;
  diagnostics(): readonly Diagnostic[];
  statistics(): TypeScriptStatistics;
  /** Analyze an opened source snapshot; configured projects include compiler resolution. */
  moduleInfo(resource: Resource, context?: OpenContext): Promise<TypeScriptModuleInfo>;
}

interface NodeRecord { readonly snapshot: NodeSnapshot; readonly node: ts.Node; readonly children: readonly string[]; readonly parent?: string; }
interface FileState { readonly resource: Resource; readonly path: string; readonly text: string; readonly sourceFile: ts.SourceFile; readonly nodes: ReadonlyMap<string, NodeRecord>; readonly container?: NodeSnapshot; readonly project?: ProjectState; }
interface FileObservation { readonly text: string; readonly revision: Revision; }
interface ProjectState {
  readonly key: string;
  readonly service: ts.LanguageService;
  readonly program: ts.Program;
  readonly files: Map<string, FileState>;
  readonly inputs: ReadonlyMap<string, FileObservation | undefined>;
  readonly existence: ReadonlyMap<string, boolean>;
  readonly configuration: string;
}
interface Internals { openMounted(container: NodeSnapshot, context: OpenContext): Promise<ResourceHandle | undefined>; }
const adapterInternals = new WeakMap<TypeScriptAdapter, Internals>();

const identity = { stability: "revision" as const, description: "compiler syntax kind and UTF-16 source range within one file revision" };
const kind = (name: TypeScriptNodeKind, attributes: NodeKindSchema["attributes"]): NodeKindSchema => ({ kind: name, attributes, identity });
const schema = defineAdapterSchema({
  namespace: "ts", version: "1.0.0", dynamic: false,
  kinds: [
    kind("ts::source-file", { language: { scalar: "string", cardinality: "one", required: true }, declaration: { scalar: "boolean", cardinality: "one", required: true } }),
    kind("ts::function", { name: { scalar: "string", cardinality: "one", required: true } }),
    kind("ts::class", { name: { scalar: "string", cardinality: "one", required: true } }),
    kind("ts::variable", { name: { scalar: "string", cardinality: "one", required: true } }),
    kind("ts::call", { callee: { scalar: "string", cardinality: "one", required: true } }),
    kind("ts::identifier", { name: { scalar: "string", cardinality: "one", required: true }, declaration: { scalar: "boolean", cardinality: "one", required: true } }),
    kind("ts::import", { module: { scalar: "string", cardinality: "one", required: true } }),
    kind("ts::node", { syntaxKind: { scalar: "string", cardinality: "one", required: true } }),
  ],
  edges: [
    { name: "ts::mount", role: "child", from: ["fs::file"], to: ["ts::source-file"], ordering: "stable" },
    { name: "ts::children", role: "child", from: ["ts::source-file", "ts::function", "ts::class", "ts::variable", "ts::call", "ts::import", "ts::node"], to: ["ts::function", "ts::class", "ts::variable", "ts::call", "ts::identifier", "ts::import", "ts::node"], ordering: "stable" },
    { name: "ts::symbol", role: "reference", from: ["ts::identifier"], to: ["ts::identifier", "ts::function", "ts::class", "ts::variable"], ordering: "stable" },
    { name: "ts::container", role: "reference", from: ["ts::source-file"], to: ["fs::file"], ordering: "stable" },
  ],
  operations: [
    { kind: "ts::rename-symbol", arguments: { name: { type: "string", cardinality: "one", required: true } } },
    { kind: "ts::replace-call", arguments: { callee: { type: "string", cardinality: "one", required: true } } },
  ],
  treeViews: [{ name: "ts::syntax-tree", rootKinds: ["ts::source-file"], childEdges: ["ts::mount", "ts::children"], default: true }],
  capabilities: { traversal: ["tree", "reference"], pushdown: [], ordering: "stable", revisions: true, transactions: "local", semanticOperations: true, parallelReads: false, parallelWrites: false },
});

const abort = (signal?: AbortSignal): void => signal?.throwIfAborted();
const revisionOf = (stat: Awaited<ReturnType<typeof lstat>>): Revision => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const pathOf = (uri: string): string => resolve(uri.startsWith("file:") ? fileURLToPath(uri) : uri);
const canonicalPath = (path: string): string => {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); }
  catch { return absolute; }
};
const idFor = (path: string): string => createHash("sha256").update(path).digest("base64url").slice(0, 24);
const observeFile = (path: string): FileObservation => {
  const revision = revisionOf(lstatSync(path));
  const text = readFileSync(path, "utf8");
  if (revisionOf(lstatSync(path)) !== revision) throw new Error(`TypeScript source changed while reading ${pathToFileURL(path).href}.`);
  return Object.freeze({ text, revision });
};
const currentRevision = (path: string): Revision | undefined => {
  try { return revisionOf(lstatSync(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
};
const localFor = (node: ts.Node): string => `${node.kind}:${node.pos}:${node.end}`;
const nodeKind = (node: ts.Node): TypeScriptNodeKind => {
  if (ts.isSourceFile(node)) return "ts::source-file";
  if (ts.isFunctionLike(node)) return "ts::function";
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return "ts::class";
  if (ts.isVariableDeclaration(node)) return "ts::variable";
  if (ts.isCallExpression(node)) return "ts::call";
  if (ts.isIdentifier(node)) return "ts::identifier";
  if (ts.isImportDeclaration(node)) return "ts::import";
  return "ts::node";
};
const nodeName = (node: ts.Node): string => {
  const named = node as ts.NamedDeclaration;
  return named.name === undefined ? "" : named.name.getText(node.getSourceFile());
};
const attributesFor = (node: ts.Node): NodeSnapshot["attributes"] => {
  if (ts.isSourceFile(node)) return { language: node.fileName.endsWith(".js") || node.fileName.endsWith(".jsx") ? "javascript" : "typescript", declaration: node.isDeclarationFile };
  if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isVariableDeclaration(node)) return { name: nodeName(node) };
  if (ts.isCallExpression(node)) return { callee: node.expression.getText(node.getSourceFile()) };
  if (ts.isIdentifier(node)) return { name: node.text, declaration: (node.parent as ts.NamedDeclaration).name === node };
  if (ts.isImportDeclaration(node)) return { module: ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : node.moduleSpecifier.getText(node.getSourceFile()) };
  return { syntaxKind: ts.SyntaxKind[node.kind] ?? String(node.kind) };
};

const operationTarget = (snapshot: NodeSnapshot) => ({ resource: snapshot.id.resource, target: snapshot.id, ...(snapshot.origin?.revision === undefined ? {} : { expectedRevision: snapshot.origin.revision }) });
export const typeScriptRenameSymbol = (identifier: NodeSnapshot, name: string): TypeScriptRenameSymbolOperation => {
  if (identifier.kind !== "ts::identifier" || identifier.id.adapter !== "ts") throw new TypeError("Expected a TypeScript identifier.");
  if (!/^[$A-Z_a-z][$\w]*$/u.test(name)) throw new TypeError("Expected a valid identifier name.");
  return immutableCopy({ kind: "ts::rename-symbol", ...operationTarget(identifier), payload: { name } });
};
export const typeScriptReplaceCall = (call: NodeSnapshot, callee: string): TypeScriptReplaceCallOperation => {
  if (call.kind !== "ts::call" || call.id.adapter !== "ts") throw new TypeError("Expected a TypeScript call node.");
  if (callee.length === 0 || /[\r\n]/u.test(callee)) throw new TypeError("Replacement callee must be a non-empty expression.");
  return immutableCopy({ kind: "ts::replace-call", ...operationTarget(call), payload: { callee } });
};

const canonicalSymbol = (state: FileState, node: ts.Node): ts.Symbol | undefined => {
  const checker = state.project?.program.getTypeChecker();
  const value = checker?.getSymbolAtLocation(node);
  if (value === undefined) return undefined;
  return (value.flags & ts.SymbolFlags.Alias) !== 0 ? checker?.getAliasedSymbol(value) : value;
};
const findNodeId = (state: FileState, node: ts.Node): NodeId | undefined => {
  const path = canonicalPath(node.getSourceFile().fileName);
  return (path === state.path ? state : state.project?.files.get(path))?.nodes.get(localFor(node))?.snapshot.id;
};

export const createTypeScriptAdapter = (options: TypeScriptAdapterOptions = {}): TypeScriptAdapter => {
  const project = options.project === undefined ? undefined : canonicalPath(options.project);
  const resources = new Map<string, FileState>();
  const syntaxSources = new Map<string, ts.SourceFile>();
  const reportedSources = new WeakSet<ts.SourceFile>();
  const diagnostics: Diagnostic[] = [];
  const statistics = { programsCreated: 0, sourceFilesParsed: 0, nodesProjected: 0, opened: 0, closed: 0 };
  let currentProject: ProjectState | undefined;
  const syntaxOnlyReported = new Set<string>();
  const syntaxCheckers = new WeakMap<ts.SourceFile, ts.TypeChecker>();
  const syntaxCheckerFor = (state: FileState): ts.TypeChecker => {
    const cached = syntaxCheckers.get(state.sourceFile);
    if (cached) return cached;
    // Bind only the observed source. This host never reads dependencies or disk.
    const sameFile = (path: string): boolean => ts.sys.useCaseSensitiveFileNames ? resolve(path) === state.path : resolve(path).toLowerCase() === state.path.toLowerCase();
    const program = ts.createProgram([state.path], { noLib: true, noResolve: true, allowJs: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }, {
      getSourceFile: path => sameFile(path) ? state.sourceFile : undefined,
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => dirname(state.path),
      getCanonicalFileName: path => ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase(),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => "\n",
      fileExists: sameFile,
      readFile: path => sameFile(path) ? state.text : undefined,
    });
    statistics.programsCreated += 1;
    const checker = program.getTypeChecker();
    syntaxCheckers.set(state.sourceFile, checker);
    return checker;
  };

  const reportDiagnostics = (
    sourceFile: ts.SourceFile,
    revision: Revision,
    values: readonly ts.Diagnostic[],
  ): void => {
    for (const diagnostic of values) {
      const start = diagnostic.start ?? 0;
      diagnostics.push(defineDiagnostic({
        code: "ts.syntax-error", severity: "error",
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        locations: [{ kind: "source", origin: { uri: pathToFileURL(sourceFile.fileName).href, revision, range: { start, end: start + (diagnostic.length ?? 1) } } }],
      }));
    }
  };

  const buildState = (sourceFile: ts.SourceFile, observation: FileObservation, projectState?: ProjectState, container?: NodeSnapshot): FileState => {
    const path = canonicalPath(sourceFile.fileName);
    const { revision } = observation;
    const id = idFor(JSON.stringify([path, revision, projectState?.key, container?.id]));
    const cached = resources.get(id);
    if (cached !== undefined) return cached;
    const resource = defineResource({ id, adapter: "ts", uri: pathToFileURL(path).href, revision });
    const nodeRecords = new Map<string, NodeRecord>();
    const visit = (node: ts.Node, parent?: ts.Node): void => {
      const local = localFor(node);
      const children: ts.Node[] = [];
      node.forEachChild((child) => { children.push(child); });
      const start = node.getStart(sourceFile, false);
      nodeRecords.set(local, {
        snapshot: defineNodeSnapshot({ id: { adapter: "ts", resource: resource.id, local }, kind: nodeKind(node), attributes: attributesFor(node), origin: { uri: resource.uri, revision, range: { start, end: node.end } } }),
        node, children: children.map(localFor), ...(parent === undefined ? {} : { parent: localFor(parent) }),
      });
      statistics.nodesProjected += 1;
      for (const child of children) visit(child, node);
    };
    visit(sourceFile);
    if (!reportedSources.has(sourceFile)) {
      reportedSources.add(sourceFile);
      statistics.sourceFilesParsed += 1;
      const syntaxDiagnostics = projectState?.program.getSyntacticDiagnostics(sourceFile) ??
        ts.transpileModule(sourceFile.text, {
          fileName: sourceFile.fileName,
          reportDiagnostics: true,
          compilerOptions: {},
        }).diagnostics ?? [];
      reportDiagnostics(sourceFile, revision, syntaxDiagnostics);
    }
    const state: FileState = Object.freeze({ resource, path, text: sourceFile.text, sourceFile, nodes: nodeRecords, ...(projectState === undefined ? {} : { project: projectState }), ...(container === undefined ? {} : { container }) });
    resources.set(resource.id, state);
    return state;
  };

  const ensureProject = (): ProjectState | undefined => {
    if (project === undefined) return undefined;
    const configPath = project;
    const inputs = new Map<string, FileObservation | undefined>();
    const existence = new Map<string, boolean>();
    let sealed = false;
    const readObserved = (fileName: string): string | undefined => {
      const path = canonicalPath(fileName);
      if (!inputs.has(path) && !sealed) inputs.set(path, currentRevision(path) === undefined ? undefined : observeFile(path));
      return inputs.get(path)?.text;
    };
    const fileExists = (fileName: string): boolean => {
      const path = canonicalPath(fileName);
      if (!existence.has(path) && !sealed) existence.set(path, ts.sys.fileExists(path));
      return existence.get(path) ?? false;
    };
    const config = ts.readConfigFile(configPath, readObserved);
    if (config.error !== undefined) throw new TypeError(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, { ...ts.sys, readFile: readObserved, fileExists }, dirname(configPath), undefined, configPath);
    const projectFiles = parsed.fileNames.map(canonicalPath);
    const configuration = JSON.stringify([projectFiles, parsed.options, parsed.projectReferences]);
    if (currentProject !== undefined && currentProject.configuration === configuration &&
      [...currentProject.inputs].every(([path, observation]) => currentRevision(path) === observation?.revision) &&
      [...currentProject.existence].every(([path, exists]) => ts.sys.fileExists(path) === exists)) return currentProject;
    if ((parsed.projectReferences?.length ?? 0) > 0) {
      diagnostics.push(defineDiagnostic({
        code: "ts.project-references-unsupported",
        severity: "warning",
        message: "Configured project references are not loaded transitively by the initial TypeScript adapter.",
        locations: [{ kind: "source", origin: { uri: pathToFileURL(configPath).href } }],
      }));
    }
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...projectFiles],
      getScriptVersion: () => "1",
      getScriptSnapshot: (fileName) => { const text = readObserved(fileName); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
      getCurrentDirectory: () => dirname(configPath),
      getCompilationSettings: () => parsed.options,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists, readFile: readObserved,
    };
    const service = ts.createLanguageService(host);
    statistics.programsCreated += 1;
    const program = service.getProgram();
    if (program === undefined) { service.dispose(); throw new TypeError("TypeScript compiler could not create a project program."); }
    sealed = true;
    const key = idFor(JSON.stringify([configuration, [...inputs].map(([path, value]) => [path, value?.revision]), [...existence]]));
    const state: ProjectState = { key, service, program, files: new Map(), inputs, existence, configuration };
    for (const source of program.getSourceFiles()) {
      const path = canonicalPath(source.fileName);
      if (!projectFiles.includes(path)) continue;
      const observation = inputs.get(path);
      if (observation !== undefined) state.files.set(path, buildState(source, observation, state));
    }
    currentProject = state;
    return state;
  };

  const openPath = async (path: string, container: NodeSnapshot | undefined, context: OpenContext): Promise<ResourceHandle> => {
    abort(context.signal);
    const projectState = ensureProject();
    const absolute = canonicalPath(path);
    let state = projectState?.files.get(absolute);
    if (state === undefined) {
      const observation = observeFile(absolute);
      const key = JSON.stringify([absolute, observation.revision]);
      const source = syntaxSources.get(key) ?? ts.createSourceFile(absolute, observation.text, ts.ScriptTarget.Latest, true);
      syntaxSources.set(key, source);
      state = buildState(source, observation, undefined, container);
      if (project !== undefined) diagnostics.push(defineDiagnostic({ code: "ts.outside-project", severity: "info", message: `${pathToFileURL(absolute).href} is outside the configured project and uses syntax-only mode.`, locations: [{ kind: "source", origin: { uri: pathToFileURL(absolute).href } }] }));
    } else if (container !== undefined) {
      state = buildState(state.sourceFile, { text: state.text, revision: state.resource.revision! }, projectState, container);
    }
    if (container?.origin?.revision !== undefined && container.origin.revision !== state.resource.revision) {
      throw new Error(`TypeScript source changed after filesystem observation: ${state.resource.uri}.`);
    }
    abort(context.signal);
    statistics.opened += 1;
    if (project === undefined && !syntaxOnlyReported.has(absolute)) {
      syntaxOnlyReported.add(absolute);
      diagnostics.push(defineDiagnostic({
        code: "ts.syntax-only",
        severity: "info",
        message: `${pathToFileURL(absolute).href} uses syntax-only mode because no TypeScript project is configured.`,
        locations: [{ kind: "source", origin: { uri: pathToFileURL(absolute).href } }],
      }));
    }
    let closed = false;
    return Object.freeze({ resource: state.resource, async close() { if (!closed) { closed = true; statistics.closed += 1; } } });
  };

  const stateFor = (id: string): FileState => { const value = resources.get(id); if (value === undefined) throw new TypeError(`Unknown TypeScript resource ${id}.`); return value; };

  const read: ReadCapability = {
    open(source: SourceDescriptor, context) { return openPath(pathOf(source.uri), undefined, context); },
    roots(resource, request: RootRequest) { return { async *[Symbol.asyncIterator]() { abort(request.signal); const root = stateFor(resource.id).nodes.get(localFor(stateFor(resource.id).sourceFile)); if (root !== undefined) yield root.snapshot; } }; },
    edges(id, request) { return { async *[Symbol.asyncIterator]() {
      abort(request.signal); const state = stateFor(id.resource); const record = state.nodes.get(id.local); if (record === undefined) return; const direction = request.direction ?? "forward";
      if (direction === "forward" && (request.names === undefined || request.names.includes("ts::children")) && (request.roles === undefined || request.roles.includes("child"))) for (const [ordinal, local] of record.children.entries()) { const child = state.nodes.get(local); if (child !== undefined) yield defineEdge({ name: "ts::children", role: "child", from: id, to: child.snapshot.id, ordinal }); }
      if (direction === "reverse" && record.parent !== undefined && (request.names === undefined || request.names.includes("ts::children")) && (request.roles === undefined || request.roles.includes("child"))) { const parent = state.nodes.get(record.parent); if (parent !== undefined) yield defineEdge({ name: "ts::children", role: "child", from: parent.snapshot.id, to: id, ordinal: parent.children.indexOf(id.local) }); }
      if (direction === "forward" && ts.isIdentifier(record.node) && (request.names === undefined || request.names.includes("ts::symbol")) && (request.roles === undefined || request.roles.includes("reference"))) { const symbol = canonicalSymbol(state, record.node); const declaration = symbol?.declarations?.[0]; const target = declaration === undefined ? undefined : findNodeId(state, ts.isIdentifier(declaration) ? declaration : (declaration as ts.NamedDeclaration).name ?? declaration); if (target !== undefined && !(target.resource === id.resource && target.local === id.local)) yield defineEdge({ name: "ts::symbol", role: "reference", from: id, to: target, ordinal: 0 }); }
      if (direction === "forward" && ts.isSourceFile(record.node) && state.container !== undefined && (request.names === undefined || request.names.includes("ts::container")) && (request.roles === undefined || request.roles.includes("reference"))) yield defineEdge({ name: "ts::container", role: "reference", from: id, to: state.container.id, ordinal: 0 });
    } }; },
    async hydrate(ids, projection: AttributeProjection) { const values: NodeSnapshot[] = []; for (const id of ids) { abort(projection.signal); const value = id.adapter === "ts" ? resources.get(id.resource)?.nodes.get(id.local) : undefined; if (value !== undefined) values.push(value.snapshot); } return Object.freeze(values); },
  };

  const changeFor = async (state: FileState, operation: TypeScriptOperation, patches: readonly TypeScriptPatch[]): Promise<TypeScriptChange> => {
    const revision = revisionOf(await lstat(state.path));
    if (revision !== state.resource.revision) throw new Error(`TypeScript source changed for ${state.resource.uri}.`);
    let content = state.text;
    for (const patch of [...patches].toSorted((left, right) => right.range.start - left.range.start)) content = `${content.slice(0, patch.range.start)}${patch.replacement}${content.slice(patch.range.end)}`;
    const precondition: TypeScriptPrecondition = { resource: state.resource.id, uri: state.resource.uri, expectedRevision: revision, expectation: "exists", description: "TypeScript source must retain its observed filesystem revision." };
    return immutableCopy({
      adapter: "ts", resource: state.resource.id, resourceUri: state.resource.uri, resourceRevision: revision, kind: operation.kind, risk: "destructive", summary: operation.kind === "ts::rename-symbol" ? `Rename TypeScript symbol in ${basename(state.path)}` : `Replace TypeScript call in ${basename(state.path)}`, reversible: true,
      payload: { uri: state.resource.uri, original: state.text, content, patches }, preconditions: [precondition], regions: patches.map(({ range }) => ({ uri: state.resource.uri, range })),
      preview: { kind: "text", uri: state.resource.uri, before: state.text, after: content, sensitive: true }, transaction: { key: state.resource.uri, atomic: true, rollback: "none", compensation: "none" },
    });
  };
  const planning: PlanningCapability<TypeScriptOperation, TypeScriptChange> = { async plan(operation, context) {
    abort(context.signal); const state = stateFor(operation.resource); const record = state.nodes.get(operation.target.local); if (record === undefined) throw new TypeError("Unknown TypeScript operation target.");
    if (state.sourceFile.isDeclarationFile) throw new TypeError("Generated declaration files are projected read-only.");
    if (operation.kind === "ts::replace-call") { if (!ts.isCallExpression(record.node)) throw new TypeError("Expected call expression target."); const expression = record.node.expression; return Object.freeze([await changeFor(state, operation, [{ range: { start: expression.getStart(state.sourceFile), end: expression.end }, replacement: operation.payload.callee }])]); }
    if (!ts.isIdentifier(record.node) || state.project === undefined) throw new TypeError("Symbol rename requires an identifier in configured-project mode.");
    if (ensureProject() !== state.project) throw new Error(`TypeScript project changed for ${state.resource.uri}.`);
    const locations = state.project.service.findRenameLocations(state.path, record.node.getStart(state.sourceFile), false, false, true) ?? [];
    if (locations.length === 0) throw new TypeError("TypeScript compiler could not prove rename locations.");
    const grouped = new Map<string, TypeScriptPatch[]>();
    for (const location of locations) { const path = canonicalPath(location.fileName); const values = grouped.get(path) ?? []; values.push({ range: { start: location.textSpan.start, end: location.textSpan.start + location.textSpan.length }, replacement: operation.payload.name }); grouped.set(path, values); }
    const changes: TypeScriptChange[] = [];
    const groupedChanges = await Promise.all([...grouped].map(async ([path, patches]) => { const targetState = state.project?.files.get(path); return targetState === undefined ? undefined : changeFor(targetState, operation, patches); }));
    changes.push(...groupedChanges.filter((change): change is TypeScriptChange => change !== undefined));
    return Object.freeze(changes);
  } };
  const apply: ApplyCapability<TypeScriptChange, ApplyResult> = { async apply(changes, context) {
    abort(context.signal); const first = changes[0]; if (first === undefined) return { applied: 0, diagnostics: [] };
    if (changes.some((change) => change.payload.uri !== first.payload.uri || change.payload.original !== first.payload.original)) throw new TypeError("Atomic TypeScript changes must share one file.");
    const path = fileURLToPath(first.payload.uri); const stat = await lstat(path); const revision = revisionOf(stat);
    if (changes.some((change) => change.preconditions.some((precondition) => precondition.expectedRevision !== revision))) throw new Error(`TypeScript revision changed for ${first.payload.uri}.`);
    const current = await readFile(path, "utf8"); if (current !== first.payload.original) throw new Error(`TypeScript content changed for ${first.payload.uri}.`);
    const patches = changes.flatMap((change) => change.payload.patches).toSorted((left, right) => right.range.start - left.range.start); let text = current; let previous = Number.POSITIVE_INFINITY;
    for (const patch of patches) { if (patch.range.end > previous) throw new Error("TypeScript patches overlap."); text = `${text.slice(0, patch.range.start)}${patch.replacement}${text.slice(patch.range.end)}`; previous = patch.range.start; }
    const temporary = join(dirname(path), `.${basename(path)}.ast-${randomUUID()}`); try { await writeFile(temporary, text, { mode: stat.mode }); abort(context.signal); await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
    return Object.freeze({ applied: changes.length, diagnostics: Object.freeze([]) });
  } };

  const mount: MountCapability = { edge: "ts::mount", open(container, source, context) { return openPath(pathOf(source.uri), container, context); } };
  const adapter: TypeScriptAdapter = Object.freeze({
    contractVersion: "1",
    namespace: "ts",
    schema,
    mode: project === undefined ? "syntax-only" : "configured-project",
    ...(project === undefined ? {} : { project: pathToFileURL(project).href }),
    read,
    planning,
    apply,
    mount,
    async moduleInfo(resource: Resource, context: OpenContext = {}) {
      abort(context.signal);
      const state = stateFor(resource.id);
      if (resource.adapter !== "ts" || resource.uri !== state.resource.uri || resource.revision !== state.resource.revision) throw new TypeError("TypeScript module resource does not match its opened snapshot.");
      const program = state.project?.program;
      const configured = program && program.getSourceFile(state.path) === state.sourceFile ? program.getTypeChecker() : undefined;
      const observedResources = new Map([...state.project?.files.values() ?? []].map(file => [file.sourceFile, file.resource]));
      observedResources.set(state.sourceFile, state.resource);
      return moduleInfoFor(state.sourceFile, state.resource, observedResources, configured, () => syntaxCheckerFor(state));
    },
    diagnostics: () => Object.freeze([...diagnostics]),
    statistics: () => Object.freeze({ ...statistics }),
  });
  adapterInternals.set(adapter, { async openMounted(container, context) { if (container.kind !== "fs::file" || container.origin?.uri === undefined) throw new TypeError("TypeScript mounts require an fs::file."); return openPath(fileURLToPath(container.origin.uri), container, context); } });
  return adapter;
};

const mountedNode = (adapter: TypeScriptAdapter, snapshot: NodeSnapshot, file: NavigableNodeHandle, mountedResource = snapshot.id.resource): NavigableNodeHandle => Object.freeze({
  snapshot,
  async *edges(request: EdgeRequest = {}) {
    yield* adapter.read.edges(snapshot.id, request);
    if (snapshot.kind === "ts::source-file" && snapshot.id.resource === mountedResource) yield* mountParentEdges(snapshot, file.snapshot, "ts::mount", request);
  },
  async resolve(id: NodeId, signal?: AbortSignal) { if (id.adapter !== "ts") { if (id.adapter === file.snapshot.id.adapter && id.resource === file.snapshot.id.resource && id.local === file.snapshot.id.local) return file; return file.resolve(id, signal); } const [value] = await adapter.read.hydrate([id], { attributes: [], ...(signal === undefined ? {} : { signal }) }); return value === undefined ? undefined : mountedNode(adapter, value, file, mountedResource); },
});

const mountedHandle = (file: NavigableNodeHandle, adapter: TypeScriptAdapter): NavigableNodeHandle => Object.freeze({
  snapshot: file.snapshot,
  edges(request: EdgeRequest = {}) { return { async *[Symbol.asyncIterator]() { for await (const edge of file.edges(request)) yield edge; if (file.snapshot.kind !== "fs::file" || (request.direction ?? "forward") !== "forward" || (request.names !== undefined && !request.names.includes("ts::mount")) || (request.roles !== undefined && !request.roles.includes("child"))) return; const implementation = adapterInternals.get(adapter); if (implementation === undefined) return; const handle = await implementation.openMounted(file.snapshot, request.signal === undefined ? {} : { signal: request.signal }); if (handle === undefined) return; try { for await (const root of adapter.read.roots(handle.resource, request)) yield defineEdge({ name: "ts::mount", role: "child", from: file.snapshot.id, to: root.id, ordinal: 0 }); } finally { await closeQueryResource(handle); } } }; },
  async resolve(id: NodeId, signal?: AbortSignal) {
    abort(signal);
    if (id.adapter !== "ts") {
      const resolved = await file.resolve(id, signal);
      return resolved === undefined ? undefined : mountedHandle(resolved, adapter);
    }
    const [value] = await adapter.read.hydrate([id], {
      attributes: [], ...(signal === undefined ? {} : { signal }),
    });
    return value === undefined ? undefined : mountedNode(adapter, value, mountedHandle(file, adapter));
  },
});
export const mountTypeScript = <Captures extends CaptureMap>(files: Query<NavigableNodeHandle, Captures>, adapter: TypeScriptAdapter): Query<NavigableNodeHandle, Captures> => files.project((file) => mountedHandle(file, adapter), `mount typescript (${adapter.mode})`);
