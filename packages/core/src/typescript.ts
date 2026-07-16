import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

import type { Adapter, ApplyCapability, ApplyResult, AttributeProjection, OpenContext, Operation, PlanningCapability, ReadCapability, ResourceHandle, RootRequest, SourceDescriptor } from "./adapter.js";
import type { Change, ChangePrecondition, ChangeRegion, ChangeTransaction, TextChangePreview } from "./change.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import { defineEdge, defineNodeSnapshot, defineResource } from "./model.js";
import type { EdgeRequest, NodeId, NodeSnapshot, Resource, Revision, SourceRange } from "./model.js";
import type { CaptureMap, NavigableNodeHandle, Query } from "./query.js";
import { defineAdapterSchema } from "./schema.js";
import type { NodeKindSchema } from "./schema.js";

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
  readonly read: ReadCapability;
  readonly planning: PlanningCapability<TypeScriptOperation, TypeScriptChange>;
  readonly apply: ApplyCapability<TypeScriptChange, ApplyResult>;
  diagnostics(): readonly Diagnostic[];
  statistics(): TypeScriptStatistics;
}

interface NodeRecord { readonly snapshot: NodeSnapshot; readonly node: ts.Node; readonly children: readonly string[]; readonly parent?: string; }
interface FileState { readonly resource: Resource; readonly path: string; readonly text: string; readonly sourceFile: ts.SourceFile; readonly nodes: ReadonlyMap<string, NodeRecord>; readonly container?: NodeSnapshot; }
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
const idFor = (path: string): string => createHash("sha256").update(path).digest("base64url").slice(0, 24);
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

export const createTypeScriptAdapter = (options: TypeScriptAdapterOptions = {}): TypeScriptAdapter => {
  const files = new Map<string, FileState>();
  const resources = new Map<string, FileState>();
  const diagnostics: Diagnostic[] = [];
  const statistics = { programsCreated: 0, sourceFilesParsed: 0, nodesProjected: 0, opened: 0, closed: 0 };
  let service: ts.LanguageService | undefined;
  let projectFiles: readonly string[] = [];
  let compilerOptions: ts.CompilerOptions = {};
  const versions = new Map<string, string>();

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

  const buildState = async (sourceFile: ts.SourceFile, container?: NodeSnapshot): Promise<FileState> => {
    const path = resolve(sourceFile.fileName);
    const stat = await lstat(path);
    const revision = revisionOf(stat);
    const resource = defineResource({ id: idFor(path), adapter: "ts", uri: pathToFileURL(path).href, revision });
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
    statistics.sourceFilesParsed += 1;
    const syntaxDiagnostics = service?.getProgram()?.getSyntacticDiagnostics(sourceFile) ??
      ts.transpileModule(sourceFile.text, {
        fileName: sourceFile.fileName,
        reportDiagnostics: true,
        compilerOptions,
      }).diagnostics ?? [];
    reportDiagnostics(sourceFile, revision, syntaxDiagnostics);
    const state: FileState = Object.freeze({ resource, path, text: sourceFile.text, sourceFile, nodes: nodeRecords, ...(container === undefined ? {} : { container }) });
    files.set(path, state); resources.set(resource.id, state);
    return state;
  };

  const ensureProject = async (): Promise<void> => {
    if (options.project === undefined || service !== undefined) return;
    const configPath = resolve(options.project);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error !== undefined) throw new TypeError(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
    if ((parsed.projectReferences?.length ?? 0) > 0) {
      diagnostics.push(defineDiagnostic({
        code: "ts.project-references-unsupported",
        severity: "warning",
        message: "Configured project references are not loaded transitively by the initial TypeScript adapter.",
        locations: [{ kind: "source", origin: { uri: pathToFileURL(configPath).href } }],
      }));
    }
    projectFiles = parsed.fileNames.map((fileName) => resolve(fileName));
    compilerOptions = parsed.options;
    for (const path of projectFiles) versions.set(path, "1");
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...projectFiles],
      getScriptVersion: (fileName) => versions.get(resolve(fileName)) ?? "1",
      getScriptSnapshot: (fileName) => { const text = ts.sys.readFile(fileName); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
      getCurrentDirectory: () => dirname(configPath),
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: ts.getDefaultLibFilePath,
      fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
    };
    service = ts.createLanguageService(host);
    statistics.programsCreated += 1;
    const program = service.getProgram();
    if (program !== undefined) {
      const sources = program.getSourceFiles().filter((source) => projectFiles.includes(resolve(source.fileName)));
      await Promise.all(sources.map((source) => buildState(source)));
    }
  };

  const openPath = async (path: string, container: NodeSnapshot | undefined, context: OpenContext): Promise<ResourceHandle> => {
    abort(context.signal); statistics.opened += 1;
    await ensureProject();
    const absolute = resolve(path);
    let state = files.get(absolute);
    if (state === undefined) {
      const text = await readFile(absolute, "utf8");
      const scriptKind = absolute.endsWith(".js") || absolute.endsWith(".jsx") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const source = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, scriptKind);
      state = await buildState(source, container);
      if (options.project !== undefined) diagnostics.push(defineDiagnostic({ code: "ts.outside-project", severity: "info", message: `${pathToFileURL(absolute).href} is outside the configured project and uses syntax-only mode.`, locations: [{ kind: "source", origin: { uri: pathToFileURL(absolute).href } }] }));
    } else if (container !== undefined) {
      state = Object.freeze({ ...state, container }); files.set(absolute, state); resources.set(state.resource.id, state);
    }
    let closed = false;
    return Object.freeze({ resource: state.resource, async close() { if (!closed) { closed = true; statistics.closed += 1; } } });
  };

  const checker = (): ts.TypeChecker | undefined => service?.getProgram()?.getTypeChecker();
  const canonicalSymbol = (node: ts.Node): ts.Symbol | undefined => {
    const value = checker()?.getSymbolAtLocation(node);
    if (value === undefined) return undefined;
    return (value.flags & ts.SymbolFlags.Alias) !== 0 ? checker()?.getAliasedSymbol(value) : value;
  };
  const findNodeId = (node: ts.Node): NodeId | undefined => files.get(resolve(node.getSourceFile().fileName))?.nodes.get(localFor(node))?.snapshot.id;
  const stateFor = (id: string): FileState => { const value = resources.get(id); if (value === undefined) throw new TypeError(`Unknown TypeScript resource ${id}.`); return value; };

  const read: ReadCapability = {
    open(source: SourceDescriptor, context) { return openPath(pathOf(source.uri), undefined, context); },
    roots(resource, request: RootRequest) { return { async *[Symbol.asyncIterator]() { abort(request.signal); const root = stateFor(resource.id).nodes.get(localFor(stateFor(resource.id).sourceFile)); if (root !== undefined) yield root.snapshot; } }; },
    edges(id, request) { return { async *[Symbol.asyncIterator]() {
      abort(request.signal); const state = stateFor(id.resource); const record = state.nodes.get(id.local); if (record === undefined) return; const direction = request.direction ?? "forward";
      if (direction === "forward" && (request.names === undefined || request.names.includes("ts::children")) && (request.roles === undefined || request.roles.includes("child"))) for (const [ordinal, local] of record.children.entries()) { const child = state.nodes.get(local); if (child !== undefined) yield defineEdge({ name: "ts::children", role: "child", from: id, to: child.snapshot.id, ordinal }); }
      if (direction === "reverse" && record.parent !== undefined && (request.names === undefined || request.names.includes("ts::children")) && (request.roles === undefined || request.roles.includes("child"))) { const parent = state.nodes.get(record.parent); if (parent !== undefined) yield defineEdge({ name: "ts::children", role: "child", from: parent.snapshot.id, to: id, ordinal: parent.children.indexOf(id.local) }); }
      if (direction === "forward" && ts.isIdentifier(record.node) && (request.names === undefined || request.names.includes("ts::symbol")) && (request.roles === undefined || request.roles.includes("reference"))) { const symbol = canonicalSymbol(record.node); const declaration = symbol?.declarations?.[0]; const target = declaration === undefined ? undefined : findNodeId(ts.isIdentifier(declaration) ? declaration : (declaration as ts.NamedDeclaration).name ?? declaration); if (target !== undefined && !(target.resource === id.resource && target.local === id.local)) yield defineEdge({ name: "ts::symbol", role: "reference", from: id, to: target, ordinal: 0 }); }
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
    if (!ts.isIdentifier(record.node) || service === undefined) throw new TypeError("Symbol rename requires an identifier in configured-project mode.");
    const locations = service.findRenameLocations(state.path, record.node.getStart(state.sourceFile), false, false, true) ?? [];
    if (locations.length === 0) throw new TypeError("TypeScript compiler could not prove rename locations.");
    const grouped = new Map<string, TypeScriptPatch[]>();
    for (const location of locations) { const path = resolve(location.fileName); const values = grouped.get(path) ?? []; values.push({ range: { start: location.textSpan.start, end: location.textSpan.start + location.textSpan.length }, replacement: operation.payload.name }); grouped.set(path, values); }
    const changes: TypeScriptChange[] = [];
    const groupedChanges = await Promise.all([...grouped].map(async ([path, patches]) => { const targetState = files.get(path); return targetState === undefined ? undefined : changeFor(targetState, operation, patches); }));
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

  const adapter: TypeScriptAdapter = Object.freeze({ namespace: "ts", schema, read, planning, apply, diagnostics: () => Object.freeze([...diagnostics]), statistics: () => Object.freeze({ ...statistics }) });
  adapterInternals.set(adapter, { async openMounted(container, context) { if (container.kind !== "fs::file" || container.origin?.uri === undefined) throw new TypeError("TypeScript mounts require an fs::file."); return openPath(fileURLToPath(container.origin.uri), container, context); } });
  return adapter;
};

const mountedNode = (adapter: TypeScriptAdapter, snapshot: NodeSnapshot, file: NavigableNodeHandle): NavigableNodeHandle => Object.freeze({
  snapshot,
  edges(request: EdgeRequest = {}) { return adapter.read.edges(snapshot.id, request); },
  async resolve(id: NodeId, signal?: AbortSignal) { if (id.adapter !== "ts") { if (id.adapter === file.snapshot.id.adapter && id.resource === file.snapshot.id.resource && id.local === file.snapshot.id.local) return file; return file.resolve(id, signal); } const [value] = await adapter.read.hydrate([id], { attributes: [], ...(signal === undefined ? {} : { signal }) }); return value === undefined ? undefined : mountedNode(adapter, value, file); },
});

const mountedHandle = (file: NavigableNodeHandle, adapter: TypeScriptAdapter): NavigableNodeHandle => Object.freeze({
  snapshot: file.snapshot,
  edges(request: EdgeRequest = {}) { return { async *[Symbol.asyncIterator]() { for await (const edge of file.edges(request)) yield edge; if (file.snapshot.kind !== "fs::file" || (request.direction ?? "forward") !== "forward" || (request.names !== undefined && !request.names.includes("ts::mount")) || (request.roles !== undefined && !request.roles.includes("child"))) return; const implementation = adapterInternals.get(adapter); if (implementation === undefined) return; const handle = await implementation.openMounted(file.snapshot, request.signal === undefined ? {} : { signal: request.signal }); if (handle === undefined) return; try { for await (const root of adapter.read.roots(handle.resource, request)) yield defineEdge({ name: "ts::mount", role: "child", from: file.snapshot.id, to: root.id, ordinal: 0 }); } finally { await handle.close(); } } }; },
  async resolve(id: NodeId, signal?: AbortSignal) { if (id.adapter !== "ts") return file.resolve(id, signal); const [value] = await adapter.read.hydrate([id], { attributes: [], ...(signal === undefined ? {} : { signal }) }); return value === undefined ? undefined : mountedNode(adapter, value, file); },
});
export const mountTypeScript = <Captures extends CaptureMap>(files: Query<NavigableNodeHandle, Captures>, adapter: TypeScriptAdapter): Query<NavigableNodeHandle, Captures> => files.project((file) => mountedHandle(file, adapter), "mount typescript");
