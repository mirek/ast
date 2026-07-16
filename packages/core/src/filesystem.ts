import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
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
  TextChangePreview,
} from "./change.js";
import { defineDiagnostic } from "./diagnostic.js";
import type { Diagnostic } from "./diagnostic.js";
import { defineEdge, defineNodeSnapshot, defineResource } from "./model.js";
import type {
  Edge,
  EdgeRequest,
  NodeId,
  NodeSnapshot,
  Resource,
  Revision,
} from "./model.js";
import { fromValues } from "./query.js";
import type { ExecuteOptions, NavigableNodeHandle, Query } from "./query.js";
import { defineAdapterSchema } from "./schema.js";

export type FilesystemNodeKind = "fs::directory" | "fs::file" | "fs::symlink";
export type FilesystemOperationKind = "fs::write" | "fs::move" | "fs::remove" | "fs::create";
export type FilesystemContent =
  | { readonly encoding: "utf8"; readonly content: string }
  | { readonly encoding: "base64"; readonly content: string };

export interface FilesystemSource {
  readonly uri: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly kinds?: readonly FilesystemNodeKind[];
  readonly minSize?: number;
  readonly maxSize?: number;
  readonly modifiedAfter?: number;
  readonly modifiedBefore?: number;
}

interface FilesystemOperationBase<
  Kind extends FilesystemOperationKind,
  Payload,
> extends Operation<Kind, Payload> {
  readonly expectedRevision?: Revision;
}

export type FilesystemWriteOperation = FilesystemOperationBase<
  "fs::write",
  FilesystemContent
> & { readonly target: NodeId };
export type FilesystemMoveOperation = FilesystemOperationBase<
  "fs::move",
  { readonly destination: string }
> & { readonly target: NodeId };
export type FilesystemRemoveOperation = FilesystemOperationBase<
  "fs::remove",
  Readonly<Record<never, never>>
> & { readonly target: NodeId };
export type FilesystemCreateOperation = FilesystemOperationBase<
  "fs::create",
  {
    readonly name: string;
    readonly nodeKind: "file" | "directory";
    readonly content?: FilesystemContent;
  }
> & { readonly target: NodeId };
export type FilesystemOperation =
  | FilesystemWriteOperation
  | FilesystemMoveOperation
  | FilesystemRemoveOperation
  | FilesystemCreateOperation;

export type FilesystemChangeRisk = "safe" | "destructive";

export interface FilesystemPrecondition extends ChangePrecondition {
  readonly path: string;
}

export interface FilesystemChange extends Change<Readonly<Record<string, unknown>>> {
  readonly adapter: "fs";
  readonly kind: FilesystemOperationKind;
  readonly risk: FilesystemChangeRisk;
  readonly preconditions: readonly FilesystemPrecondition[];
  readonly regions: readonly ChangeRegion[];
  readonly preview?: TextChangePreview;
}

export interface FilesystemStatistics {
  readonly opened: number;
  readonly closed: number;
  readonly directoriesRead: number;
  readonly entriesRead: number;
  readonly nodesObserved: number;
  readonly ioOperations: number;
  readonly ioDurationMs: number;
}

export interface FilesystemAdapterOptions {
  readonly ignore?: readonly string[];
  readonly clock?: () => number;
}

export interface FilesystemAdapter extends Adapter {
  readonly namespace: "fs";
  readonly read: ReadCapability;
  readonly planning: PlanningCapability<FilesystemOperation, FilesystemChange>;
  readonly apply: ApplyCapability<FilesystemChange, ApplyResult>;
  walk(source: FilesystemSource, context?: ExecuteOptions): AsyncIterable<NavigableNodeHandle>;
  diagnostics(): readonly Diagnostic[];
  statistics(): FilesystemStatistics;
}

interface ResourceState {
  readonly resource: Resource;
  readonly root: string;
  readonly canonicalRoot: string;
  readonly exclude: readonly string[];
}

interface MutableStatistics {
  opened: number;
  closed: number;
  directoriesRead: number;
  entriesRead: number;
  nodesObserved: number;
  ioOperations: number;
  ioDurationMs: number;
}

const schema = defineAdapterSchema({
  namespace: "fs",
  version: "1.0.0",
  dynamic: false,
  kinds: (["fs::directory", "fs::file", "fs::symlink"] as const).map((kind) => ({
    kind,
    attributes: {
      name: { scalar: "string", cardinality: "one", required: true },
      path: { scalar: "string", cardinality: "one", required: true },
      extension: { scalar: "string", cardinality: "one", required: true },
      size: { scalar: "number", cardinality: "one", required: true },
      modifiedMs: { scalar: "number", cardinality: "one", required: true },
      mode: { scalar: "number", cardinality: "one", required: true },
      hidden: { scalar: "boolean", cardinality: "one", required: true },
      contentKind: { scalar: "string", cardinality: "one", required: false },
    },
    identity: {
      stability: "revision" as const,
      description: "normalized root-relative path within one filesystem observation",
    },
  })),
  edges: [
    {
      name: "fs::children",
      role: "child",
      from: ["fs::directory"],
      to: ["fs::directory", "fs::file", "fs::symlink"],
      ordering: "stable",
    },
    {
      name: "fs::target",
      role: "reference",
      from: ["fs::symlink"],
      to: ["fs::directory", "fs::file", "fs::symlink"],
      ordering: "stable",
    },
  ],
  operations: [
    {
      kind: "fs::write",
      arguments: {
        content: { type: "string", cardinality: "one", required: true },
        encoding: { type: "string", cardinality: "one", required: true },
      },
    },
    {
      kind: "fs::move",
      arguments: {
        destination: { type: "string", cardinality: "one", required: true },
      },
    },
    { kind: "fs::remove", arguments: {} },
    {
      kind: "fs::create",
      arguments: {
        name: { type: "string", cardinality: "one", required: true },
        nodeKind: { type: "string", cardinality: "one", required: true },
        content: { type: "string", cardinality: "one", required: false },
        encoding: { type: "string", cardinality: "one", required: false },
      },
    },
  ],
  treeViews: [
    {
      name: "fs::directory-tree",
      rootKinds: ["fs::directory", "fs::file", "fs::symlink"],
      childEdges: ["fs::children"],
      default: true,
    },
  ],
  capabilities: {
    traversal: ["tree", "reference"],
    pushdown: ["predicate"],
    ordering: "stable",
    revisions: true,
    transactions: "none",
    semanticOperations: true,
    parallelReads: true,
    parallelWrites: false,
  },
});

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  signal?.throwIfAborted();
};

const sourcePath = (uri: string): string =>
  resolve(uri.startsWith("file:") ? fileURLToPath(uri) : uri);

const posixRelative = (root: string, path: string): string => {
  const value = relative(root, path);
  return value.length === 0 ? "." : value.split(sep).join("/");
};

const absolutePath = (root: string, local: string): string => {
  if (local === ".") return root;
  if (isAbsolute(local) || local.split("/").includes("..")) {
    throw new TypeError(`Filesystem path ${JSON.stringify(local)} escapes its resource root.`);
  }
  const path = resolve(root, ...local.split("/"));
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new TypeError(`Filesystem path ${JSON.stringify(local)} escapes its resource root.`);
  }
  return path;
};

const revisionOf = (stat: Awaited<ReturnType<typeof lstat>>): Revision =>
  [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");

const nodeKind = (stat: Awaited<ReturnType<typeof lstat>>): FilesystemNodeKind => {
  if (stat.isSymbolicLink()) return "fs::symlink";
  if (stat.isDirectory()) return "fs::directory";
  return "fs::file";
};

const resourceKey = (root: string, exclude: readonly string[]): string =>
  createHash("sha256")
    .update(root)
    .update("\0")
    .update(exclude.join("\0"))
    .digest("base64url")
    .slice(0, 24);

const matchesAny = (path: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => matchesGlob(path, pattern));

const isExcluded = (
  path: string,
  kind: FilesystemNodeKind,
  patterns: readonly string[],
): boolean =>
  matchesAny(path, patterns) ||
  (kind === "fs::directory" && matchesAny(`${path}/`, patterns));

const pushedDown = (source: FilesystemSource): string => {
  const values = [
    source.exclude === undefined ? undefined : "exclude",
    source.include === undefined ? undefined : "glob",
    source.kinds === undefined ? undefined : "kind",
    source.minSize === undefined && source.maxSize === undefined ? undefined : "size",
    source.modifiedAfter === undefined && source.modifiedBefore === undefined
      ? undefined
      : "modified",
  ];
  return values.filter((value): value is string => value !== undefined).join(", ");
};

const assertFiniteNumber = (label: string, value: number | undefined): void => {
  if (value !== undefined && !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
};

const validateSource = (source: FilesystemSource): void => {
  if (source.uri.length === 0) throw new TypeError("Filesystem source URI must not be empty.");
  assertFiniteNumber("Minimum size", source.minSize);
  assertFiniteNumber("Maximum size", source.maxSize);
  assertFiniteNumber("Modified-after time", source.modifiedAfter);
  assertFiniteNumber("Modified-before time", source.modifiedBefore);
  if (source.minSize !== undefined && source.minSize < 0) {
    throw new RangeError("Minimum size must not be negative.");
  }
  if (source.maxSize !== undefined && source.maxSize < 0) {
    throw new RangeError("Maximum size must not be negative.");
  }
  if (
    source.minSize !== undefined &&
    source.maxSize !== undefined &&
    source.minSize > source.maxSize
  ) {
    throw new RangeError("Minimum size must not exceed maximum size.");
  }
  if (
    source.modifiedAfter !== undefined &&
    source.modifiedBefore !== undefined &&
    source.modifiedAfter >= source.modifiedBefore
  ) {
    throw new RangeError("Modified-after time must precede modified-before time.");
  }
};

const assertFilesystemSnapshot = (
  snapshot: NodeSnapshot,
  kinds: readonly FilesystemNodeKind[],
): void => {
  if (snapshot.id.adapter !== "fs" || !kinds.includes(snapshot.kind as FilesystemNodeKind)) {
    throw new TypeError(
      `Expected a filesystem ${kinds.map((kind) => kind.slice(4)).join(" or ")} node.`,
    );
  }
};

const assertContent = (content: FilesystemContent): void => {
  if (
    (content.encoding !== "utf8" && content.encoding !== "base64") ||
    typeof content.content !== "string"
  ) {
    throw new TypeError("Filesystem content must be an explicitly encoded string.");
  }
};

const operationTarget = (
  snapshot: NodeSnapshot,
): { readonly resource: string; readonly target: NodeId; readonly expectedRevision?: Revision } => ({
  resource: snapshot.id.resource,
  target: snapshot.id,
  ...(snapshot.origin?.revision === undefined
    ? {}
    : { expectedRevision: snapshot.origin.revision }),
});

export const filesystemWrite = (
  snapshot: NodeSnapshot,
  content: FilesystemContent,
): FilesystemWriteOperation => {
  assertFilesystemSnapshot(snapshot, ["fs::file"]);
  assertContent(content);
  return Object.freeze({
    kind: "fs::write",
    ...operationTarget(snapshot),
    payload: Object.freeze({ ...content }),
  });
};

export const filesystemMove = (
  snapshot: NodeSnapshot,
  destination: string,
): FilesystemMoveOperation => {
  assertFilesystemSnapshot(snapshot, ["fs::directory", "fs::file", "fs::symlink"]);
  return Object.freeze({
    kind: "fs::move",
    ...operationTarget(snapshot),
    payload: Object.freeze({ destination }),
  });
};

export const filesystemRemove = (snapshot: NodeSnapshot): FilesystemRemoveOperation => {
  assertFilesystemSnapshot(snapshot, ["fs::directory", "fs::file", "fs::symlink"]);
  return Object.freeze({
    kind: "fs::remove",
    ...operationTarget(snapshot),
    payload: Object.freeze({}),
  });
};

export const filesystemCreate = (
  directory: NodeSnapshot,
  name: string,
  kind: "file" | "directory",
  content?: FilesystemContent,
): FilesystemCreateOperation => {
  assertFilesystemSnapshot(directory, ["fs::directory"]);
  if (content !== undefined) assertContent(content);
  if (kind === "directory" && content !== undefined) {
    throw new TypeError("A directory create operation cannot contain file content.");
  }
  return Object.freeze({
    kind: "fs::create",
    ...operationTarget(directory),
    payload: Object.freeze({
      name,
      nodeKind: kind,
      ...(content === undefined ? {} : { content: Object.freeze({ ...content }) }),
    }),
  });
};

export const createFilesystemAdapter = (
  options: FilesystemAdapterOptions = {},
): FilesystemAdapter => {
  const defaultIgnore = Object.freeze([...(options.ignore ?? [])]);
  const resources = new Map<string, ResourceState>();
  const diagnostics: Diagnostic[] = [];
  const statistics: MutableStatistics = {
    opened: 0,
    closed: 0,
    directoriesRead: 0,
    entriesRead: 0,
    nodesObserved: 0,
    ioOperations: 0,
    ioDurationMs: 0,
  };
  const clock = options.clock ?? (() => performance.now());
  const io = async <T>(operation: () => Promise<T>): Promise<T> => {
    const start = clock();
    statistics.ioOperations += 1;
    try { return await operation(); }
    finally { statistics.ioDurationMs += Math.max(0, clock() - start); }
  };

  const recordFailure = (
    path: string,
    error: unknown,
    operation?: FilesystemOperationKind,
  ): void => {
    const code = (error as NodeJS.ErrnoException).code;
    const classification =
      code === "ENOENT"
        ? { diagnostic: "fs.path-disappeared", severity: "warning" as const, reason: "path disappeared" }
        : code === "EACCES" || code === "EPERM"
          ? { diagnostic: "fs.permission-denied", severity: "error" as const, reason: "permission was denied" }
          : code === "ELOOP"
            ? { diagnostic: "fs.symlink-loop", severity: "warning" as const, reason: "symbolic-link loop" }
            : { diagnostic: "fs.read-failed", severity: "error" as const, reason: "filesystem read failed" };
    diagnostics.push(
      defineDiagnostic({
        code: classification.diagnostic,
        severity: classification.severity,
        message: `Cannot observe ${pathToFileURL(path).href}: ${classification.reason}.`,
        locations: [
          { kind: "source", origin: { uri: pathToFileURL(path).href } },
          ...(operation === undefined
            ? []
            : ([{ kind: "operation", operation }] as const)),
        ],
      }),
    );
  };

  const stateFor = (resource: Resource | string): ResourceState => {
    const id = typeof resource === "string" ? resource : resource.id;
    const state = resources.get(id);
    if (state === undefined) throw new TypeError(`Unknown filesystem resource ${id}.`);
    return state;
  };

  const observe = async (
    state: ResourceState,
    path: string,
    signal?: AbortSignal,
  ): Promise<NodeSnapshot | undefined> => {
    throwIfAborted(signal);
    try {
      const stat = await io(() => lstat(path));
      throwIfAborted(signal);
      statistics.nodesObserved += 1;
      const kind = nodeKind(stat);
      const local = posixRelative(state.root, path);
      const name = local === "." ? basename(state.root) : basename(path);
      const revision = revisionOf(stat);
      return defineNodeSnapshot({
        id: { adapter: "fs", resource: state.resource.id, local },
        kind,
        attributes: {
          name,
          path: local,
          extension: kind === "fs::file" ? extname(name) : "",
          size: stat.size,
          modifiedMs: stat.mtimeMs,
          mode: stat.mode,
          hidden: name.startsWith("."),
          ...(kind === "fs::file" ? { contentKind: "opaque" } : {}),
        },
        origin: { uri: pathToFileURL(path).href, revision },
      });
    } catch (error) {
      recordFailure(path, error);
      return undefined;
    }
  };

  const children = async (
    directory: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> => {
    throwIfAborted(signal);
    try {
      statistics.directoriesRead += 1;
      const entries = await io(() => readdir(directory, { withFileTypes: true }));
      throwIfAborted(signal);
      statistics.entriesRead += entries.length;
      return entries
        .map(({ name }) => name)
        .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    } catch (error) {
      recordFailure(directory, error);
      return [];
    }
  };

  const matchesSource = (node: NodeSnapshot, source: FilesystemSource): boolean => {
    const path = node.attributes.path;
    const size = node.attributes.size;
    const modifiedMs = node.attributes.modifiedMs;
    if (typeof path !== "string" || typeof size !== "number" || typeof modifiedMs !== "number") {
      return false;
    }
    if (source.include !== undefined && !matchesAny(path, source.include)) return false;
    if (source.kinds !== undefined && !source.kinds.includes(node.kind as FilesystemNodeKind)) {
      return false;
    }
    if (source.minSize !== undefined && size < source.minSize) return false;
    if (source.maxSize !== undefined && size > source.maxSize) return false;
    if (source.modifiedAfter !== undefined && modifiedMs <= source.modifiedAfter) return false;
    if (source.modifiedBefore !== undefined && modifiedMs >= source.modifiedBefore) return false;
    return true;
  };

  const walkSnapshots = (
    state: ResourceState,
    source: FilesystemSource,
    signal?: AbortSignal,
  ): AsyncIterable<NodeSnapshot> => ({
    async *[Symbol.asyncIterator]() {
      const visit = async function* (path: string): AsyncIterable<NodeSnapshot> {
        throwIfAborted(signal);
        const node = await observe(state, path, signal);
        if (node === undefined) return;
        const local = node.id.local;
        const excluded = local !== "." && isExcluded(local, node.kind as FilesystemNodeKind, state.exclude);
        if (excluded) return;
        if (matchesSource(node, source)) yield node;
        if (node.kind !== "fs::directory") return;
        for (const name of await children(path, signal)) {
          throwIfAborted(signal);
          yield* visit(resolve(path, name));
        }
      };
      yield* visit(state.root);
    },
  });

  const read: ReadCapability = {
    async open(source: SourceDescriptor, context: OpenContext): Promise<ResourceHandle> {
      throwIfAborted(context.signal);
      const root = sourcePath(source.uri);
      const rootStat = await io(() => lstat(root));
      const canonicalRoot = await io(() => realpath(root));
      throwIfAborted(context.signal);
      const sourceExclude = source.options?.exclude;
      const excludes = Array.isArray(sourceExclude)
        ? sourceExclude.filter((value): value is string => typeof value === "string")
        : [];
      const exclude = Object.freeze([...defaultIgnore, ...excludes]);
      const resource = defineResource({
        id: resourceKey(root, exclude),
        adapter: "fs",
        uri: pathToFileURL(root).href,
        revision: revisionOf(rootStat),
      });
      const state = Object.freeze({ resource, root, canonicalRoot, exclude });
      resources.set(resource.id, state);
      statistics.opened += 1;
      let closed = false;
      return Object.freeze({
        resource,
        async close() {
          if (!closed) {
            closed = true;
            statistics.closed += 1;
          }
        },
      });
    },

    roots(resource: Resource, request: RootRequest): AsyncIterable<NodeSnapshot> {
      return {
        async *[Symbol.asyncIterator]() {
          const state = stateFor(resource);
          const root = await observe(state, state.root, request.signal);
          if (root !== undefined) yield root;
        },
      };
    },

    edges(node: NodeId, request: EdgeRequest): AsyncIterable<Edge> {
      return {
        async *[Symbol.asyncIterator]() {
          const state = stateFor(node.resource);
          const path = absolutePath(state.root, node.local);
          const snapshot = await observe(state, path, request.signal);
          if (snapshot === undefined) return;
          const requestedNames = request.names;
          const requestedRoles = request.roles;
          const direction = request.direction ?? "forward";

          if (direction === "reverse") return;
          if (
            snapshot.kind === "fs::directory" &&
            (requestedNames === undefined || requestedNames.includes("fs::children")) &&
            (requestedRoles === undefined || requestedRoles.includes("child"))
          ) {
            let ordinal = 0;
            for (const name of await children(path, request.signal)) {
              throwIfAborted(request.signal);
              // Reads stay sequential to preserve backpressure and directory order.
              // oxlint-disable-next-line no-await-in-loop
              const child = await observe(state, resolve(path, name), request.signal);
              if (child === undefined) continue;
              if (isExcluded(child.id.local, child.kind as FilesystemNodeKind, state.exclude)) {
                continue;
              }
              yield defineEdge({
                name: "fs::children",
                role: "child",
                from: snapshot.id,
                to: child.id,
                ordinal,
              });
              ordinal += 1;
            }
          }

          if (
            snapshot.kind === "fs::symlink" &&
            (requestedNames === undefined || requestedNames.includes("fs::target")) &&
            (requestedRoles === undefined || requestedRoles.includes("reference"))
          ) {
            try {
              const targetPath = await io(() => realpath(path));
              throwIfAborted(request.signal);
              const local = relative(state.canonicalRoot, targetPath);
              if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
                diagnostics.push(
                  defineDiagnostic({
                    code: "fs.symlink-outside-root",
                    severity: "warning",
                    message: `Symbolic link ${pathToFileURL(path).href} targets outside its resource root.`,
                    locations: [
                      {
                        kind: "node",
                        node: snapshot.id,
                        ...(snapshot.origin === undefined ? {} : { origin: snapshot.origin }),
                      },
                    ],
                  }),
                );
                return;
              }
              const target = await observe(
                state,
                absolutePath(state.root, local),
                request.signal,
              );
              if (target !== undefined) {
                yield defineEdge({
                  name: "fs::target",
                  role: "reference",
                  from: snapshot.id,
                  to: target.id,
                  ordinal: 0,
                });
              }
            } catch (error) {
              recordFailure(path, error);
            }
          }
        },
      };
    },

    async hydrate(
      ids: readonly NodeId[],
      projection: AttributeProjection,
    ): Promise<readonly NodeSnapshot[]> {
      const values = await Promise.all(
        ids.map(async (id) => {
          throwIfAborted(projection.signal);
          if (id.adapter !== "fs") return undefined;
          const state = stateFor(id.resource);
          return observe(
            state,
            absolutePath(state.root, id.local),
            projection.signal,
          );
        }),
      );
      return Object.freeze(
        values.filter((value): value is NodeSnapshot => value !== undefined),
      );
    },
  };

  const navigable = (snapshot: NodeSnapshot): NavigableNodeHandle =>
    Object.freeze({
      snapshot,
      edges(request: EdgeRequest = {}) {
        return read.edges(snapshot.id, request);
      },
      async resolve(id: NodeId, signal?: AbortSignal) {
        throwIfAborted(signal);
        const resolved = await read.hydrate([id], {
          attributes: [],
          ...(signal === undefined ? {} : { signal }),
        });
        const value = resolved[0];
        return value === undefined ? undefined : navigable(value);
      },
    });

  const currentRevision = async (
    state: ResourceState,
    local: string,
    operation: FilesystemOperationKind,
  ): Promise<Revision | undefined> => {
    const path = absolutePath(state.root, local);
    try {
      return revisionOf(await io(() => lstat(path)));
    } catch (error) {
      recordFailure(path, error, operation);
      return undefined;
    }
  };

  const planning: PlanningCapability<FilesystemOperation, FilesystemChange> = {
    async plan(operation, context) {
      throwIfAborted(context.signal);
      const state = stateFor(operation.resource);
      const local = operation.target.local;
      const revision = await currentRevision(state, local, operation.kind);
      if (revision === undefined) return [];
      if (operation.expectedRevision !== undefined && operation.expectedRevision !== revision) {
        diagnostics.push(
          defineDiagnostic({
            code: "fs.revision-conflict",
            severity: "error",
            message: `Filesystem path ${JSON.stringify(local)} changed after it was observed.`,
            locations: [
              {
                kind: "node",
                node: operation.target,
                origin: { uri: pathToFileURL(absolutePath(state.root, local)).href, revision },
              },
              { kind: "operation", operation: operation.kind },
            ],
          }),
        );
        return [];
      }

      const targetUri = pathToFileURL(absolutePath(state.root, local)).href;
      const existing: FilesystemPrecondition = Object.freeze({
        resource: operation.resource,
        path: local,
        uri: targetUri,
        expectedRevision: revision,
        expectation: "exists",
        description: "Path must retain its observed filesystem revision.",
      });
      const resourceFields = {
        resourceUri: state.resource.uri,
        ...(state.resource.revision === undefined
          ? {}
          : { resourceRevision: state.resource.revision }),
      };
      let change: FilesystemChange;
      if (operation.kind === "fs::write") {
        const preview = operation.payload.encoding === "utf8"
          ? Object.freeze({
              kind: "text" as const,
              uri: targetUri,
              before: await io(() => readFile(absolutePath(state.root, local), "utf8")),
              after: operation.payload.content,
              sensitive: true,
            })
          : undefined;
        change = {
          adapter: "fs",
          resource: operation.resource,
          ...resourceFields,
          kind: operation.kind,
          risk: "destructive",
          summary: `Write ${local}`,
          reversible: false,
          payload: Object.freeze({ path: local, uri: targetUri, ...operation.payload }),
          preconditions: [existing],
          regions: [{ uri: targetUri }],
          ...(preview === undefined ? {} : { preview }),
        };
      } else if (operation.kind === "fs::move") {
        const destinationPath = absolutePath(state.root, operation.payload.destination);
        const destinationUri = pathToFileURL(destinationPath).href;
        change = {
          adapter: "fs",
          resource: operation.resource,
          ...resourceFields,
          kind: operation.kind,
          risk: "safe",
          summary: `Move ${local} to ${operation.payload.destination}`,
          reversible: true,
          payload: Object.freeze({
            path: local,
            uri: targetUri,
            destination: operation.payload.destination,
            destinationUri,
          }),
          preconditions: [
            existing,
            Object.freeze({
              resource: operation.resource,
              path: operation.payload.destination,
              uri: destinationUri,
              expectation: "absent",
              description: "Destination path must not exist.",
            }),
          ],
          regions: [{ uri: targetUri }, { uri: destinationUri }],
        };
      } else if (operation.kind === "fs::remove") {
        change = {
          adapter: "fs",
          resource: operation.resource,
          ...resourceFields,
          kind: operation.kind,
          risk: "destructive",
          summary: `Remove ${local}`,
          reversible: false,
          payload: Object.freeze({ path: local, uri: targetUri }),
          preconditions: [existing],
          regions: [{ uri: targetUri }],
        };
      } else {
        if (
          operation.payload.name.length === 0 ||
          operation.payload.name === "." ||
          operation.payload.name === ".." ||
          operation.payload.name.includes("/") ||
          operation.payload.name.includes("\\")
        ) {
          throw new TypeError("Created filesystem node name must be one path segment.");
        }
        const path = local === "." ? operation.payload.name : `${local}/${operation.payload.name}`;
        const createdUri = pathToFileURL(absolutePath(state.root, path)).href;
        change = {
          adapter: "fs",
          resource: operation.resource,
          ...resourceFields,
          kind: operation.kind,
          risk: "safe",
          summary: `Create ${operation.payload.nodeKind} ${path}`,
          reversible: true,
          payload: Object.freeze({
            path,
            uri: createdUri,
            nodeKind: operation.payload.nodeKind,
            ...operation.payload.content,
          }),
          preconditions: [
            Object.freeze({
              resource: operation.resource,
              path: local,
              uri: targetUri,
              expectation: "exists",
              description: "Parent directory must still exist.",
            }),
            Object.freeze({
              resource: operation.resource,
              path,
              uri: createdUri,
              expectation: "absent",
              description: "Destination path must not exist.",
            }),
          ],
          regions: [{ uri: createdUri }],
        };
      }
      return Object.freeze([
        Object.freeze({
          ...change,
          preconditions: Object.freeze([...change.preconditions]),
          regions: Object.freeze([...change.regions]),
        }),
      ]);
    },
  };

  const revisionAt = async (uri: string): Promise<Revision | undefined> => {
    try {
      return revisionOf(await io(() => lstat(fileURLToPath(uri))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const apply: ApplyCapability<FilesystemChange, ApplyResult> = {
    async apply(changes, context) {
      throwIfAborted(context.signal);
      for (const change of changes) {
        for (const precondition of change.preconditions) {
          throwIfAborted(context.signal);
          // Preconditions are checked before any effect in this adapter call.
          // oxlint-disable-next-line no-await-in-loop
          const actual = await revisionAt(precondition.uri);
          if (precondition.expectation === "absent" ? actual !== undefined : actual === undefined) {
            throw new Error(`Filesystem precondition failed for ${precondition.uri}.`);
          }
          if (
            precondition.expectedRevision !== undefined &&
            actual !== precondition.expectedRevision
          ) {
            throw new Error(`Filesystem revision changed for ${precondition.uri}.`);
          }
        }
      }
      let applied = 0;
      for (const change of changes) {
        throwIfAborted(context.signal);
        const uri = change.payload.uri;
        if (typeof uri !== "string") throw new TypeError("Filesystem change URI is missing.");
        const path = fileURLToPath(uri);
        if (change.kind === "fs::write") {
          const encoding = change.payload.encoding;
          const content = change.payload.content;
          if (
            (encoding !== "utf8" && encoding !== "base64") ||
            typeof content !== "string"
          ) {
            throw new TypeError("Filesystem write payload is invalid.");
          }
          // oxlint-disable-next-line no-await-in-loop
          await io(() => writeFile(path, encoding === "utf8" ? content : Buffer.from(content, "base64")));
        } else if (change.kind === "fs::move") {
          const destinationUri = change.payload.destinationUri;
          if (typeof destinationUri !== "string") {
            throw new TypeError("Filesystem move destination URI is missing.");
          }
          // oxlint-disable-next-line no-await-in-loop
          await io(() => rename(path, fileURLToPath(destinationUri)));
        } else if (change.kind === "fs::remove") {
          // oxlint-disable-next-line no-await-in-loop
          await io(() => rm(path, { recursive: true }));
        } else {
          if (change.payload.nodeKind === "directory") {
            // oxlint-disable-next-line no-await-in-loop
            await io(() => mkdir(path));
          } else {
            const encoding = change.payload.encoding;
            const content = change.payload.content;
            if (encoding === undefined && content === undefined) {
              // oxlint-disable-next-line no-await-in-loop
              await io(() => writeFile(path, "", { flag: "wx" }));
            } else if (
              (encoding === "utf8" || encoding === "base64") &&
              typeof content === "string"
            ) {
              // oxlint-disable-next-line no-await-in-loop
              await io(() => writeFile(
                path,
                encoding === "utf8" ? content : Buffer.from(content, "base64"),
                { flag: "wx" },
              ));
            } else {
              throw new TypeError("Filesystem create payload is invalid.");
            }
          }
        }
        applied += 1;
      }
      return Object.freeze({ applied, diagnostics: Object.freeze([]) });
    },
  };

  const adapter: FilesystemAdapter = {
    contractVersion: "1",
    namespace: "fs",
    schema,
    read,
    planning,
    apply,
    walk(source, context = {}) {
      validateSource(source);
      const exclude = Object.freeze([...(source.exclude ?? [])]);
      const descriptor: SourceDescriptor = {
        uri: source.uri,
        ...(exclude.length === 0 ? {} : { options: { exclude } }),
      };
      return {
        async *[Symbol.asyncIterator]() {
          const handle = await read.open(descriptor, context);
          try {
            const state = stateFor(handle.resource);
            for await (const snapshot of walkSnapshots(state, source, context.signal)) {
              throwIfAborted(context.signal);
              yield navigable(snapshot);
            }
          } finally {
            await handle.close();
          }
        },
      };
    },
    diagnostics: () => Object.freeze([...diagnostics]),
    statistics: () => Object.freeze({ ...statistics }),
  };
  return Object.freeze(adapter);
};

export const fromFilesystem = (
  adapter: FilesystemAdapter,
  source: FilesystemSource,
): Query<NavigableNodeHandle> => {
  validateSource(source);
  return fromValues(
    (options) => adapter.walk(source, options),
    {
      ordering: "stable",
      label: "fs",
      details: {
        uri: pathToFileURL(sourcePath(source.uri)).href,
        pushdown: pushedDown(source),
      },
    },
  );
};
