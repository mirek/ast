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
explicit `utf8` and `base64` encodings. Effects occur only when a validated plan
is passed to the explicit `applyChangePlan` boundary.

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

## Change plans and explicit apply

`planOperations` composes adapter operations into one immutable plan. It orders
declared dependencies, detects overlapping source regions, records schema and
resource identities, and groups changes by their honest transaction boundary.
Planning and rendering never apply effects.

```ts
import {
  applyChangePlan,
  planOperations,
  renderChangePlan,
} from "@mirek/ast";

const plan = await planOperations([
  { id: "update-manifest", adapter: json, operation },
]);

console.log(renderChangePlan(plan)); // source content is redacted by default
const result = await applyChangePlan(plan, [json]);
```

`serializeChangePlan` and `deserializeChangePlan` preserve adapter schema
versions, resource identities and revisions, risks, dependencies, and private
payloads behind an integrity-checked format. Apply revalidates every revision.
The default failure policy stops after a failed group;
`continue-independent` may continue only dependency-independent work. Reports
distinguish failed and skipped groups and state whether partial application
occurred. JSON document groups use an atomic local replacement. Filesystem
groups report that rollback and compensation are unavailable rather than
implying cross-file atomicity.

## Markdown adapter

`createMarkdownAdapter` exposes loss-aware syntax blocks and derived heading
sections. Queries select either `markdown::syntax-tree` or
`markdown::section-tree`; selector combinators then use that view's declared
child edges.

```ts
const markdown = createMarkdownAdapter({ json });
const sections = select(
  markdown,
  {
    uri: "README.md",
    options: { treeView: "markdown::section-tree" },
  },
  "markdown::document > markdown::section[level <= 2]",
  { treeView: "markdown::section-tree" },
);
```

`mountMarkdown` adds documents lazily beneath filesystem files. JSON fenced
blocks can mount through the supplied JSON adapter without losing the path back
to their code block and original file; embedded JSON is read-only, so edits are
owned by Markdown. `markdownSetHeading` and `markdownReplaceSection` emit
revision-guarded localized patches that compose in the explicit change-plan
runtime.

The initial parser handles YAML-delimited frontmatter, ATX headings, paragraphs,
flat lists, inline and reference links, fenced code, and opaque HTML paragraphs.
Duplicate headings retain distinct source-order identities. Skipped heading
levels and unclosed fences/frontmatter produce ranged diagnostics. Unsupported
constructs remain paragraph text, and no operation reformats unrelated source.

## TypeScript adapter

`createTypeScriptAdapter` projects immutable compiler syntax snapshots. With a
`project` path it creates one cached language service for the configured files
and exposes `ts::symbol` reference edges separately from `ts::children` syntax
containment. Without a project, TypeScript and JavaScript remain queryable in
syntax-only mode.

```ts
const typescript = createTypeScriptAdapter({ project: "tsconfig.json" });
const calls = select(
  typescript,
  { uri: "src/index.ts" },
  'ts::call[callee = "deprecatedApi"]',
);
```

`mountTypeScript` adds source files lazily beneath filesystem files.
`typeScriptRenameSymbol` uses compiler-proven rename locations across project
files and does not rewrite equal comments or string literals.
`typeScriptReplaceCall` replaces only the selected call expression's callee.
Both operations produce revision-guarded, atomic per-file changes.

The runtime adapter pins the stable TypeScript 5.9 compiler API; the workspace
may use a newer compiler for its own build. Syntax errors have source ranges.
Out-of-project files are explicitly syntax-only, generated declaration files
are read-only, and project references are diagnosed as unsupported by the
initial adapter instead of being loaded incompletely.

## Development

Requires Node.js 24 or newer and pnpm 11 or newer.

```sh
pnpm install
pnpm check
pnpm build
```
