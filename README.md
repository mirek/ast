# ast

`ast` explores one typed node-graph model, query system, and change-planning
runtime for heterogeneous structured resources such as repositories, source
code, documents, and databases.

The repository contains the architecture specification, implementation backlog,
and a buildable TypeScript monorepo. `@mirek/ast` provides immutable graph,
resource, schema, diagnostic, and capability contracts plus an executable lazy
query algebra, selector compiler, local filesystem adapter, and lazily mounted
JSON, Markdown, and TypeScript document adapters, textual DSL, change planning,
and the `ast` CLI.

Read [SPEC.md](./SPEC.md) for the architecture and [TODO.md](./TODO.md) for the
ordered set of work that remains.

## Workspace

- `@mirek/ast` — pure graph, adapter, query, and change-planning library; its
  model, schema, lazy query runtime, explain plans, and in-memory adapter are
  available now, together with selector parsing, schema validation, and query
  compilation; built-in and policy-validated plugin adapters provide lazy
  reads, nested mounts, and pure change planning
- `@mirek/ast-cli` — executable boundary for querying, planning, explaining,
  and explicitly applying changes

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

## Stable adapter contract

Adapters declare core contract version `1` plus an independent schema version.
`validateAdapter` rejects capability/schema mismatches before execution, while
`adapterCompatibility` returns the exact compatibility identity. Read and
cleanup, tree views, hydration, edges, planning, apply, diagnostics, and nested
mount opening are stable focused capabilities. Adapter statistics, cost
estimates, and watching remain provisional; native query compilation is an
adapter-specific extension rather than a generic callback translation API.

## SQL prototype

`createSqlAdapter` takes an observed catalog, a credential-free display URI,
and an injected `SqlClient`; the package does not add a database driver. Catalog
queries expose server, database, schema, table, column, and relation nodes
without scanning rows. `fromSqlRows` compiles catalog-validated predicates,
projections, ordering, aggregation, inner joins, offsets, and limits to
parameterized SQL and streams client rows with backpressure.
The prototype request shape uses quoted identifiers and numbered parameters;
production clients own dialect translation and must provide a genuinely atomic
`transaction` implementation.

```ts
const sql = createSqlAdapter({ uri: "sql://local/app", catalog, client });
const active = fromSqlRows(sql, {
  table: { schema: "public", name: "users" },
  select: ["id", "name"],
  where: { kind: "comparison", column: "enabled", operator: "=", value: true },
  orderBy: [{ column: "id", direction: "asc" }],
  limit: 100,
});
```

Values are always parameters and identifiers must resolve through the catalog.
Callback predicates stay in the runtime; dependent limits stay after them.
Native equijoins are explicit, while SQL-to-local joins use the ordinary
buffering equality join. Primary keys provide row identity; keyless rows state
that their identity is query-scoped.

`sqlUpdateRows` and `sqlDeleteRows` produce pure plans. Apply rechecks the
catalog revision, runs one database-local transaction, and verifies optimistic
affected-row counts when a revision column is available. This prototype claims
neither cross-resource atomicity nor post-commit reversibility.

## Textual DSL

`parseDsl`, `formatDsl`, and `compileDsl` provide a declarative pipeline surface
over the same `Query`, selector, operation, and change-plan values used by the
TypeScript API. A compile environment explicitly supplies named sources, mounts,
and adapter operation constructors.

```text
from ts("src/index.ts")
| select 'ts::call[callee = "deprecatedApi"]'
| invoke ts::replace-call { callee: "replacementApi" }
| plan
```

The initial grammar supports lexical query bindings, sources, mounts, selectors,
typed filters, projections, captures, distinctness, sorting, limits, counts,
inner equality joins, invocation, and terminal planning. It has no imports,
modules, user functions, arbitrary code execution, loops, or recursion. Parser,
selector, schema/type, capability, and planning diagnostics retain DSL source
locations, and `formatDsl` is deterministic.

## Plugins and trust

`registerPlugins` validates explicit manifests and contribution lists before a
plugin is used. Plugin adapters publish runtime-validated `dynamic: true`
schemas. Namespaces are globally unique, aliases are explicit, optimizer rules
are limited to the core-known `identity` equivalence, and saved plans bind
plugin package, API, build-integrity, and schema versions.

The CLI imports only modules listed in `.astrc.json` or an explicit `--config`
file:

```json
{
  "plugins": [{
    "specifier": "./plugins/example.mjs",
    "name": "@example/ast-plugin",
    "powers": ["resource:read"],
    "aliases": {
      "namespaces": { "ex": "example" },
      "sources": { "demo": "example::source" }
    }
  }]
}
```

Available powers distinguish resource, filesystem, and network read/write;
process execution; credential reads; and native-module loading. Missing
approval rejects registration. This is an allowlist for trusted code, not a
sandbox: importing the module executes its top-level JavaScript with the full
authority of the Node.js process. The self-declared integrity identifier must
change with the plugin build and prevents silent saved-plan replay with a
different declared implementation, but it does not attest module bytes.
`ast plugins` reports this boundary as `trustedCode: true` and `isolated: false`.

## CLI

`@mirek/ast-cli` provides the `ast` executable:

```sh
ast query query.dsl
ast plan transform.dsl --save plan.json
ast apply plan.json --yes --allow-destructive
ast explain query.dsl
ast schema json
ast plugins
```

Piped queries emit stable JSON Lines on stdout and diagnostics as separate JSON
Lines on stderr. Terminals default to readable indented values and redacted plan
diffs. Planning cannot apply. Apply never prompts in automation and requires
explicit confirmation plus risk acknowledgements. Flags override `AST_*`
environment settings, which override `.astrc.json`.

Exit codes distinguish usage (1), diagnostics (2), invalid plans (3), missing
confirmation (4), apply failure (5), and cancellation (130). SIGINT propagates
through query/apply cancellation. Rendered values redact conventional secret,
token, password, credential, and API-key fields. Explicitly saved plans contain
private adapter payloads and should be treated as sensitive files.

## Development

Requires Node.js 24 or newer and pnpm 11 or newer.

```sh
pnpm install
pnpm check
pnpm build
```
