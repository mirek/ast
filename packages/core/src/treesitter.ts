import { closeQueryResource } from "./buffering.js";
import { mountParentEdges } from "./mount.js";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSyntaxParser } from "./treesitter-parser.js";
import type { SyntaxNode, SyntaxTree } from "./treesitter-parser.js";
import type { Adapter, OpenContext, ReadCapability, ResourceHandle, SourceDescriptor } from "./adapter.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { immutableCopy } from "./immutable.js";
import { defineEdge, defineNodeSnapshot, defineResource } from "./model.js";
import type { EdgeRequest, NodeId, NodeSnapshot, Resource } from "./model.js";
import type { CaptureMap, NavigableNodeHandle, Query } from "./query.js";
import { defineAdapterSchema } from "./schema.js";

export interface TreeSitterGrammar {
  readonly name: string;
  /** Custom WASM path or file URL; absent selects the bundled language pack. */
  readonly wasm?: string;
  readonly extensions: readonly string[];
  readonly filenames?: readonly string[];
}

const bundled = (name: string, extensions: readonly string[], filenames: readonly string[] = []): TreeSitterGrammar => ({
  name, extensions, filenames,
});

export const treeSitterGrammars: readonly TreeSitterGrammar[] = immutableCopy([
  bundled("bash", [".sh", ".bash"], [".bashrc", ".bash_profile"]),
  bundled("c", [".c", ".h"]), bundled("csharp", [".cs"]),
  bundled("cpp", [".cpp", ".cc", ".cxx", ".hpp", ".hxx"]),
  bundled("css", [".css"]), bundled("dockerfile", [], ["Dockerfile", "Containerfile"]),
  bundled("elixir", [".ex", ".exs"]), bundled("erlang", [".erl", ".hrl"]),
  bundled("go", [".go"]), bundled("haskell", [".hs"]),
  bundled("html", [".html", ".htm"]), bundled("java", [".java"]),
  bundled("javascript", [".js", ".mjs", ".cjs", ".jsx"]), bundled("json", [".json"]),
  bundled("kotlin", [".kt", ".kts"]), bundled("lua", [".lua"]),
  bundled("markdown", [".md", ".markdown"]), bundled("php", [".php"]),
  bundled("python", [".py", ".pyi"]), bundled("ruby", [".rb"], ["Gemfile", "Rakefile"]),
  bundled("rust", [".rs"]), bundled("scala", [".scala", ".sc"]),
  bundled("sql", [".sql"]), bundled("svelte", [".svelte"]), bundled("swift", [".swift"]),
  bundled("toml", [".toml"]), bundled("tsx", [".tsx"]),
  bundled("typescript", [".ts", ".mts", ".cts"]), bundled("vue", [".vue"]),
  bundled("yaml", [".yaml", ".yml"]), bundled("zig", [".zig"]),
]);

export interface TreeSitterAdapterOptions {
  /** Replaces the default registry; spread treeSitterGrammars to extend it. */
  readonly grammars?: readonly TreeSitterGrammar[];
}
export interface TreeSitterMountOptions {
  readonly language?: string;
  readonly onError?: "skip" | "throw";
}
export interface TreeSitterStatistics {
  readonly opened: number;
  readonly closed: number;
  readonly filesRead: number;
  readonly parses: number;
}
export interface TreeSitterAdapter extends Adapter {
  readonly namespace: "treesitter";
  readonly read: ReadCapability;
  readonly grammars: readonly TreeSitterGrammar[];
  diagnostics(): readonly Diagnostic[];
  statistics(): TreeSitterStatistics;
}

const scalar = (type: "string" | "boolean", required = true) => ({ scalar: type, cardinality: "one" as const, required });
const schema = defineAdapterSchema({
  namespace: "treesitter", version: "1.0.0", dynamic: false,
  kinds: [{
    kind: "treesitter::node",
    attributes: { language: scalar("string"), type: scalar("string"), text: scalar("string"), field: scalar("string", false), named: scalar("boolean"), missing: scalar("boolean"), error: scalar("boolean"), hasError: scalar("boolean") },
    identity: { stability: "revision", description: "Grammar and source-order child path within one content revision and containing resource." },
  }],
  edges: [
    { name: "treesitter::mount", role: "child", from: ["fs::file"], to: ["treesitter::node"], ordering: "stable" },
    { name: "treesitter::children", role: "child", from: ["treesitter::node"], to: ["treesitter::node"], ordering: "stable" },
    { name: "treesitter::container", role: "reference", from: ["treesitter::node"], to: ["fs::file"], ordering: "stable" },
  ],
  operations: [],
  treeViews: [{ name: "treesitter::syntax-tree", rootKinds: ["treesitter::node"], childEdges: ["treesitter::mount", "treesitter::children"], default: true }],
  capabilities: { traversal: ["tree", "reference"], pushdown: [], ordering: "stable", revisions: true, transactions: "none", semanticOperations: false, parallelReads: true, parallelWrites: false },
});

interface State {
  readonly resource: Resource;
  readonly tree: SyntaxTree;
  readonly language: string;
  readonly container: NodeSnapshot | undefined;
  references: number;
}
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("base64url");
const pathOf = (uri: string): string => uri.startsWith("file:") ? fileURLToPath(uri) : uri;
const fileRevision = (stat: Awaited<ReturnType<typeof lstat>>): string =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const wanted = (request: EdgeRequest, name: `treesitter::${string}`, role: "child" | "reference"): boolean =>
  (request.names === undefined || request.names.includes(name)) && (request.roles === undefined || request.roles.includes(role));

const syntaxAt = (state: State, local: string): SyntaxNode | undefined => {
  if (!/^\$(?:\/(?:0|[1-9][0-9]*))*$/u.test(local)) return undefined;
  let node: SyntaxNode | null = state.tree.rootNode;
  for (const part of local.split("/").slice(1)) node = node?.child(Number(part)) ?? null;
  return node ?? undefined;
};
const snapshotAt = (state: State, local: string): NodeSnapshot | undefined => {
  const node = syntaxAt(state, local);
  if (node === undefined) return undefined;
  const split = local.lastIndexOf("/");
  const field = split < 0 ? null : syntaxAt(state, local.slice(0, split))?.fieldNameForChild(Number(local.slice(split + 1)));
  return defineNodeSnapshot({
    id: { adapter: "treesitter", resource: state.resource.id, local }, kind: "treesitter::node",
    attributes: { language: state.language, type: node.type, text: node.text, named: node.isNamed, missing: node.isMissing, error: node.isError, hasError: node.hasError, ...(field == null ? {} : { field }) },
    origin: { uri: state.resource.uri, revision: state.resource.revision!, range: {
      start: node.startIndex, end: node.endIndex,
      startLine: node.startPosition.row, startColumn: node.startPosition.column,
      endLine: node.endPosition.row, endColumn: node.endPosition.column,
    } },
  });
};

type OpenMounted = (container: NodeSnapshot, context: OpenContext, options: TreeSitterMountOptions) => Promise<ResourceHandle | undefined>;
const mounts = new WeakMap<TreeSitterAdapter, OpenMounted>();

export const createTreeSitterAdapter = (options: TreeSitterAdapterOptions = {}): TreeSitterAdapter => {
  const grammars = immutableCopy(options.grammars ?? treeSitterGrammars);
  const names = new Set<string>();
  const extensions = new Set<string>();
  const filenames = new Set<string>();
  for (const grammar of grammars) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(grammar.name) || names.has(grammar.name)) throw new TypeError(`Invalid or duplicate Tree-sitter grammar: ${grammar.name}`);
    names.add(grammar.name);
    if (grammar.wasm !== undefined && (!grammar.wasm || (/^[a-z]+:/iu.test(grammar.wasm) && !grammar.wasm.startsWith("file:")))) throw new TypeError("Grammar WASM must be a local path or file URL.");
    for (const extension of grammar.extensions) {
      if (!/^\.[^./]+$/u.test(extension) || extensions.has(extension)) throw new TypeError(`Invalid or ambiguous grammar extension: ${extension}`);
      extensions.add(extension);
    }
    for (const filename of grammar.filenames ?? []) {
      if (!filename || basename(filename) !== filename || filenames.has(filename)) throw new TypeError(`Invalid or ambiguous grammar filename: ${filename}`);
      filenames.add(filename);
    }
  }
  const resources = new Map<string, State>();
  const parseSyntax = createSyntaxParser();
  const diagnostics: Diagnostic[] = [];
  const statistics = { opened: 0, closed: 0, filesRead: 0, parses: 0 };
  const detect = (uri: string, language?: string): TreeSitterGrammar | undefined => {
    if (language !== undefined) {
      const grammar = grammars.find(g => g.name === language);
      if (!grammar) throw new TypeError(`Unknown Tree-sitter grammar: ${language}`);
      return grammar;
    }
    const path = pathOf(uri);
    return grammars.find(g => g.filenames?.includes(basename(path))) ?? grammars.find(g => g.extensions.includes(extname(path)));
  };
  const open = async (source: SourceDescriptor, context: OpenContext, container?: NodeSnapshot): Promise<ResourceHandle> => {
    context.signal?.throwIfAborted();
    const language = source.options?.language;
    if (language !== undefined && typeof language !== "string") throw new TypeError("Tree-sitter language must be a string.");
    const grammar = detect(source.uri, language);
    if (!grammar) throw new TypeError(`No Tree-sitter grammar for ${source.uri}; specify options.language or register a grammar.`);
    if (source.treeView !== undefined && source.treeView !== "treesitter::syntax-tree") throw new TypeError("Unknown Tree-sitter tree view.");
    const uri = pathToFileURL(pathOf(source.uri)).href;
    const before = fileRevision(await lstat(fileURLToPath(uri)));
    context.signal?.throwIfAborted();
    if (container?.origin?.revision !== undefined && container.origin.revision !== before) {
      throw new Error(`Tree-sitter source changed after filesystem observation: ${uri}.`);
    }
    const bytes = await readFile(fileURLToPath(uri), { signal: context.signal });
    statistics.filesRead += 1;
    if (fileRevision(await lstat(fileURLToPath(uri))) !== before) throw new Error(`Tree-sitter source changed while reading: ${uri}.`);
    context.signal?.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const revision = hash(bytes);
    const id = hash(JSON.stringify([uri, grammar.name, grammar.wasm, revision, container?.id]));
    let state = resources.get(id);
    if (!state) {
      const tree = await parseSyntax(grammar, text, context.signal);
      statistics.parses += 1;
      const existing = resources.get(id);
      if (existing) { tree.delete(); state = existing; }
      else {
        state = { resource: defineResource({ adapter: "treesitter", id, uri, revision }), tree, language: grammar.name, container, references: 0 };
        resources.set(id, state);
        if (tree.rootNode.hasError) diagnostics.push(defineDiagnostic({
          code: "treesitter.syntax-error", severity: "warning", message: `Tree-sitter recovered syntax errors using ${grammar.name}.`,
          locations: [{ kind: "source", origin: snapshotAt(state, "$")!.origin! }],
        }));
      }
    }
    state.references += 1;
    statistics.opened += 1;
    const observed = state;
    let closed = false;
    return Object.freeze({ resource: state.resource, async close() {
      if (closed) return;
      closed = true;
      statistics.closed += 1;
      observed.references -= 1;
      if (observed.references === 0) { resources.delete(id); observed.tree.delete(); }
    } });
  };
  const read: ReadCapability = {
    open,
    async *roots(resource, request) {
      request.signal?.throwIfAborted();
      const state = resources.get(resource.id);
      if (state) yield snapshotAt(state, "$")!;
    },
    async *edges(id, request) {
      request.signal?.throwIfAborted();
      if (id.adapter !== "treesitter") return;
      const state = resources.get(id.resource);
      if (!state) return;
      const node = syntaxAt(state, id.local);
      if (!node) return;
      if ((request.direction ?? "forward") === "forward") {
        if (wanted(request, "treesitter::children", "child")) for (let ordinal = 0; ordinal < node.childCount; ordinal += 1) {
          request.signal?.throwIfAborted();
          yield defineEdge({ name: "treesitter::children", role: "child", from: id, to: { ...id, local: `${id.local}/${ordinal}` }, ordinal });
        }
        if (id.local === "$" && state.container && wanted(request, "treesitter::container", "reference")) yield defineEdge({ name: "treesitter::container", role: "reference", from: id, to: state.container.id, ordinal: 0 });
      } else if (wanted(request, "treesitter::children", "child") && id.local !== "$") {
        const split = id.local.lastIndexOf("/");
        yield defineEdge({ name: "treesitter::children", role: "child", from: { ...id, local: id.local.slice(0, split) }, to: id, ordinal: Number(id.local.slice(split + 1)) });
      }
    },
    async hydrate(ids, projection) {
      const result: NodeSnapshot[] = [];
      for (const id of ids) {
        projection.signal?.throwIfAborted();
        const state = id.adapter === "treesitter" ? resources.get(id.resource) : undefined;
        const snapshot = state && snapshotAt(state, id.local);
        if (snapshot) result.push(snapshot);
      }
      return Object.freeze(result);
    },
  };
  const openMounted: OpenMounted = async (container, context, mountOptions) => {
    context.signal?.throwIfAborted();
    if (container.kind !== "fs::file" || !container.origin) return undefined;
    // Unrecognized extensions are discovery misses; invalid explicit names are errors.
    if (!detect(container.origin.uri, mountOptions.language)) return undefined;
    try {
      return await open({ uri: container.origin.uri, options: mountOptions.language === undefined ? {} : { language: mountOptions.language } }, context, container);
    } catch (error) {
      context.signal?.throwIfAborted();
      if (mountOptions.onError === "throw") throw error;
      diagnostics.push(defineDiagnostic({ code: "treesitter.open-failed", severity: "warning", message: error instanceof Error ? error.message : String(error), locations: [{ kind: "source", origin: container.origin }] }));
      return undefined;
    }
  };
  const adapter: TreeSitterAdapter = Object.freeze({ contractVersion: "1", namespace: "treesitter", schema, read, grammars,
    mount: { edge: "treesitter::mount" as const, open: (container: NodeSnapshot, source: { readonly uri: string; readonly text?: string }, context: OpenContext) => {
      if (source.text !== undefined) throw new TypeError("Tree-sitter text mounts are not supported.");
      return openMounted({ ...container, origin: { ...container.origin, uri: source.uri } }, context, {});
    } },
    diagnostics: () => Object.freeze([...diagnostics]), statistics: () => Object.freeze({ ...statistics }),
  });
  mounts.set(adapter, openMounted);
  return adapter;
};

const mountedHandle = (file: NavigableNodeHandle, adapter: TreeSitterAdapter, options: TreeSitterMountOptions, snapshot = file.snapshot): NavigableNodeHandle => Object.freeze({
  snapshot,
  async *edges(request: EdgeRequest = {}) {
    if (snapshot.id.adapter === "treesitter") {
      yield* adapter.read.edges(snapshot.id, request);
      if (snapshot.id.local === "$") yield* mountParentEdges(snapshot, file.snapshot, "treesitter::mount", request);
      return;
    }
    yield* file.edges(request);
    if ((request.direction ?? "forward") !== "forward" || !wanted(request, "treesitter::mount", "child")) return;
    const handle = await mounts.get(adapter)!(snapshot, request.signal === undefined ? {} : { signal: request.signal }, options);
    if (!handle) return;
    try {
      for await (const root of adapter.read.roots(handle.resource, request)) yield defineEdge({ name: "treesitter::mount", role: "child", from: snapshot.id, to: root.id, ordinal: 0 });
    } finally { await closeQueryResource(handle); }
  },
  async resolve(id: NodeId, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (id.adapter !== "treesitter") {
      if (id.adapter === file.snapshot.id.adapter && id.resource === file.snapshot.id.resource && id.local === file.snapshot.id.local) return mountedHandle(file, adapter, options);
      const resolved = await file.resolve(id, signal);
      return resolved && mountedHandle(resolved, adapter, options);
    }
    const [resolved] = await adapter.read.hydrate([id], { attributes: [], ...(signal === undefined ? {} : { signal }) });
    return resolved && mountedHandle(file, adapter, options, resolved);
  },
});

export const mountTreeSitter = <Captures extends CaptureMap>(files: Query<NavigableNodeHandle, Captures>, adapter: TreeSitterAdapter, options: TreeSitterMountOptions = {}): Query<NavigableNodeHandle, Captures> => {
  if (!mounts.has(adapter)) throw new TypeError("Unknown Tree-sitter adapter instance.");
  if (options.language !== undefined && !adapter.grammars.some(g => g.name === options.language)) throw new TypeError(`Unknown Tree-sitter grammar: ${options.language}`);
  const frozen = immutableCopy(options);
  return files.project(file => mountedHandle(file, adapter, frozen), `mount treesitter (language=${options.language ?? "auto"})`);
};
