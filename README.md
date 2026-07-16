# ast

`ast` explores one typed node-graph model, query system, and change-planning
runtime for heterogeneous structured resources such as repositories, source
code, documents, and databases.

The repository contains the architecture specification, implementation backlog,
and a buildable TypeScript monorepo. `@mirek/ast` provides immutable graph,
resource, schema, diagnostic, and capability contracts plus an executable lazy
query algebra, selector compiler, local filesystem adapter, and lazily mounted
JSON document adapter. The CLI is not yet implemented.

Read [SPEC.md](./SPEC.md) for the architecture and [TODO.md](./TODO.md) for the
ordered set of work that remains.

## Workspace

- `@mirek/ast` — pure graph, adapter, query, and change-planning library; its
  model, schema, lazy query runtime, explain plans, and in-memory adapter are
  available now, together with selector parsing, schema validation, and query
  compilation; the filesystem and JSON adapters provide lazy reads, nested
  mounts, and pure change planning
- `@mirek/ast-cli` — CLI boundary reserved for later implementation

Both packages remain private until their public names and contracts are
stabilized.

## Query runtime

Queries are immutable `AsyncIterable` values. Fluent methods and functional
combinators construct the same logical plan. Operators stream by default;
`sort`, `groupBy`, and `join` report their buffering in the physical explain
plan. Execution propagates abort signals and closes adapter resources on normal
completion, cancellation, and failure.

```ts
import { distinct, fromAdapter, project, take } from "@mirek/ast";

const roots = fromAdapter(adapter, { uri: "memory:project" });
const names = project(
  take(distinct(roots), 10),
  (node) => node.snapshot.attributes.name,
);

console.log(names.explain());
const result = await names.toArray({ signal });
```

The public algebra includes filtering, projection, flat mapping, distinctness,
limits, counting, grouping, sorting, captures, equality joins, and bounded tree
or reference-edge traversal. `createInMemoryAdapter` supplies deterministic
fixtures for adapter and selector development without filesystem effects.

Selectors use namespaced kinds and edges and compile into that same algebra.
Comparisons are checked against the adapter schema before execution; missing
attributes remain distinct from explicit `null` values.

```ts
import { select } from "@mirek/ast";

const calls = select(
  adapter,
  { uri: "memory:project" },
  'ts::function[name ^= "parse"] ts::call[callee ~= /deprecated/i]',
);

const result = await calls.toArray({ signal });
```

## Filesystem adapter

`createFilesystemAdapter` exposes directories, files, and symbolic links as a
stable path-ordered graph. Child traversal never follows symbolic links;
in-root link targets use the separate `fs::target` reference edge. File bytes
remain opaque, so querying large or binary files reads metadata rather than
embedding their contents in node attributes.

`fromFilesystem` walks lazily and pushes include/exclude globs, node kinds,
sizes, and modification-time bounds into traversal. Its physical explanation
lists those pushdowns separately from downstream runtime filters.

```ts
import { createFilesystemAdapter, fromFilesystem, take } from "@mirek/ast";

const filesystem = createFilesystemAdapter({ ignore: [".git/**"] });
const files = fromFilesystem(filesystem, {
  uri: ".",
  include: ["**/*.ts"],
  kinds: ["fs::file"],
  maxSize: 1_000_000,
});

const firstTen = await take(files, 10).toArray({ signal });
console.log(files.explain().physical.details.pushdown);
```

`filesystemWrite`, `filesystemMove`, `filesystemRemove`, and
`filesystemCreate` construct typed intent values. Passing them to
`filesystem.planning.plan` records exact observed revision preconditions but
does not touch the filesystem. UTF-8 and binary content are distinguished by
explicit `utf8` and `base64` encodings. Applying plans is intentionally deferred
to the change-plan runtime.

## JSON adapter and mounts

`createJsonAdapter` exposes roots, objects, properties, arrays, indices, and
scalar values in deterministic source order. `mountJson` wraps a filesystem
query without reading file contents. Bytes are read only if traversal requests
the `json::mount` child edge; the mounted root has a `json::container` reference
edge back to its owning `fs::file`.

```ts
import {
  createFilesystemAdapter,
  createJsonAdapter,
  fromFilesystem,
  mountJson,
} from "@mirek/ast";

const manifests = fromFilesystem(createFilesystemAdapter(), {
  uri: ".",
  include: ["**/package.json"],
  kinds: ["fs::file"],
});
const graph = mountJson(manifests, createJsonAdapter());
const nodes = await graph
  .traverse({ roles: ["child"], maxDepth: 8, includeSelf: true })
  .toArray({ signal });
```

Invalid JSON mounts are skipped by default with source-ranged diagnostics, so
other files remain queryable; `{ onError: "throw" }` selects fail-fast behavior.
UTF-8 BOM and final-newline style are observed explicitly. Value replacement,
property insertion/removal, and array insertion/removal produce revision-guarded
localized text-patch changes without touching the source. Unchanged values
retain the original bytes; structured replacements use the observed indentation
where practical and report the formatting strategy in the change payload.

## Development

Requires Node.js 24 or newer and pnpm 11 or newer.

```sh
pnpm install
pnpm check
pnpm build
```
