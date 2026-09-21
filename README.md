# ast

`ast` explores one typed node-graph model, query system, and change-planning
runtime for heterogeneous structured resources such as repositories, source
code, documents, and databases.

The repository contains the validated architecture specification, executable
conformance suite, and a buildable TypeScript monorepo. `@mirek/ast` provides
immutable graph, resource, schema, diagnostic, and capability contracts plus an
executable lazy query algebra, selector compiler, local filesystem adapter, and
lazily mounted JSON, Markdown, TypeScript, and Tree-sitter adapters, textual DSL,
change planning, and the `ast` CLI.

Read [SPEC.md](./SPEC.md) for the architecture. [TODO.md](./TODO.md) indexes the
current follow-up work found by exercising the public CLI and selector surface.

## Workspace

- `@mirek/ast` — pure graph, adapter, query, and change-planning library; its
  model, schema, lazy query runtime, explain plans, and in-memory adapter are
  available now, together with selector parsing, schema validation, and query
  compilation; built-in and policy-validated plugin adapters provide lazy
  reads, nested mounts, and pure change planning
- `@mirek/ast-cli` — executable boundary for querying, planning, explaining,
  and explicitly applying changes

Both packages remain private while release naming and versioning are decided;
the architecture and adapter contract are validated.

## Query runtime

Queries are immutable `AsyncIterable` values. Fluent methods and functional
combinators construct the same logical plan. Operators stream by default;
`sort`, `groupBy`, and `join` report their buffering in the physical explain
plan. Execution propagates abort signals and closes adapter resources on normal
completion, cancellation, and failure.

Serial projections use `@prelude/async-generator` transforms with the runtime's
capture and cancellation checks. They preserve backpressure and iterator cleanup.

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
Sorting, grouping, and equality joins keep upstream resources alive while their
buffered nodes can still be consumed. Navigation after buffering remains valid;
completion, early return, and failures release those resources. This adds the
retained parser/resource state to the memory cost of a buffering operator.
Combined buffer-execution and cleanup failures retain both errors in an
`AggregateError`, with the execution failure as its cause.
In the DSL, `sort text` can sort syntax nodes by their `text` attribute without
losing their schema or preventing a subsequent `select`.

Selectors use namespaced kinds and edges and compile into that same algebra.
Comparisons are checked against the adapter schema before execution; missing
attributes remain distinct from explicit `null` values.
`selectFrom` treats its input as resource roots by default. Pass
`{ sourceMode: "selection" }` for an already walked or otherwise preselected
node stream so matching does not recursively traverse every input row again.

Mounted views remain available after directory navigation and after returning
through a container reference. For example, this query discovers a package
directory, enters its Markdown document, returns to the file, and selects
headings from its Tree-sitter view:

```text
from fs({ uri: "." })
| mount markdown()
| mount treesitter()
| select 'fs::directory[name = "demo"] > fs::file[name = "README.md"] > markdown::document ->markdown::container fs::file as $file > treesitter::node treesitter::node[type = "atx_heading"]'
| project { file: $file.path, heading: @text }
```

The same composition applies to JSON and TypeScript file mounts and JSON inside
Markdown code blocks. Resolving directory entries or filtering files does not
open their mounted contents.

Use `<` to select a parent and `<<` to select ancestors. Both follow the selected
tree view across mount boundaries. For example, locate headings and then recover
the package directories that contain them:

```text
from fs({ uri: ".", include: ["**/*.md"], kinds: ["fs::file"] })
| mount treesitter()
| select 'treesitter::node[type = "atx_heading"] as $heading << fs::directory[name = "demo"]'
| project { package: @path, heading: $heading.text }
```

Ancestors are nearest first in a tree and exclude the starting node. Cycles are
pruned along each active path; separate paths retain duplicates until `distinct`.
Filesystem parents stop at the opened resource root. In TypeScript, use
`traverse({ direction: "reverse", roles: ["child"], edgeNames, maxDepth,
cycle: "prune" })`; supply the selected view's containment edges and use depth
one for parents. Omitting `cycle` retains bounded traversal with repeated nodes.

Sibling navigation supports `+` (next), `~` (following), `<+` (previous), and
`<~` (preceding, nearest first). These require ordered containment and use the
selected tree view. For example,
`markdown::heading[title = "Third"] <~ markdown::heading` returns preceding
heading siblings in reverse order. Immediate-sibling operators inspect the
adjacent node before applying its selector; they do not skip intervening nodes
to find a match. The same operators work in relative `:has(...)` predicates.

Select children by position with `:first-child`, `:last-child`, `:only-child`,
`:nth-child(2)`, or `:nth-last-child(2)`. The `nth` forms also accept `odd`,
`even`, and progressions such as `2n+1` or `-n + 3`. Positions are one-based
within each parent's ordered child-edge group, counting all node kinds in the
selected tree view. For example, `markdown::heading:nth-child(2)` matches a
heading only if it is the second block, including paragraphs in the count.
It does not select the second heading from the whole result stream. Roots with
no containment parent do not match positional predicates.
Only the active tree view's child edges must be ordered; unrelated tree views
do not prevent positional or sibling selection.

`:scope` explicitly matches a query's starting node. For example,
`:scope > json::object` selects a direct child of a JSON root, and
`json::scalar << :scope` returns that root from its scalar descendants. On a
preselected stream, each row is its own starting node. Selecting `:scope` alone
does not open mounted contents. In `:has(:scope > markdown::heading)`, the scope
is the node being tested; nested `:is` and `:not` preserve their surrounding
scope. A nested `related("one", ':scope', @origin.uri)` projection reads the
current node's URI without searching descendants.

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
lists those pushdowns separately from downstream runtime filters. Statistics
report resource lifecycle, entries/nodes observed, I/O count, and cumulative
I/O duration; tests can inject a deterministic clock.

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

JSON and Markdown observations retain their original contents when a reused
adapter reopens a changed file. Earlier node IDs keep resolving to the earlier
revision, and stale edit planning produces a revision-conflict diagnostic with
no changes. The adapter retains these observations for deferred planning
throughout its lifetime, including read-only JSON embedded in Markdown.

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
    treeView: "markdown::section-tree",
  },
  "markdown::document > markdown::section[level <= 2]",
  { treeView: "markdown::section-tree" },
);
```

Textual queries expose the same choice on both the direct source and the mount:

```text
from markdown({ uri: "README.md", treeView: "markdown::section-tree" })
| select 'markdown::document > markdown::section'

from fs({ uri: ".", include: ["README.md"], kinds: ["fs::file"] })
| mount markdown({ treeView: "markdown::section-tree" })
| select 'fs::file > markdown::document > markdown::section'
```

The default is `markdown::syntax-tree`. The selected view remains active for
later selector steps, including their captures, and appears in explanations.
Unknown or non-Markdown view names are source-located DSL diagnostics.

`mountMarkdown` accepts the same `treeView` option and adds documents lazily
beneath filesystem files. JSON fenced blocks can mount through the supplied
JSON adapter without losing the path back to their code block and original
file; embedded JSON is read-only, so edits are owned by Markdown.
`markdownSetHeading` and `markdownReplaceSection` emit revision-guarded
localized patches that compose in the explicit change-plan runtime.

The initial parser handles YAML-delimited frontmatter, ATX headings, paragraphs,
flat lists, inline and reference links, fenced code, and opaque HTML paragraphs.
Duplicate headings retain distinct source-order identities. Skipped heading
levels and unclosed fences/frontmatter produce ranged diagnostics. Unsupported
constructs remain paragraph text, and no operation reformats unrelated source.

## TypeScript adapter

`createTypeScriptAdapter` projects immutable compiler syntax snapshots. With a
`project` path it caches a language service for the unchanged configured files
and exposes `ts::symbol` reference edges separately from `ts::children` syntax
containment. Without a project, TypeScript and JavaScript remain queryable in
syntax-only mode.

Reopening a file observes its current revision. Configured projects also refresh
when compiler inputs, configuration, or file membership change. Earlier handles
keep their observed syntax, symbols, and mount container; rename planning rejects
an outdated project. The adapter retains observations for deferred planning
throughout its lifetime.
Cross-file symbol targets retain their own source URI and do not acquire the
referencing file as a filesystem parent.

The CLI selects that same mode explicitly with `--project <tsconfig-path>` or
with `typescriptProject` in `.astrc.json`. A command-line path resolves from the
invocation working directory; a config value resolves from the directory that
contains that config file; the command-line value wins. One adapter and
cached project observation are reused by direct `ts` sources, filesystem mounts, symbol
edges, and semantic rename planning for the invocation.

```sh
ast query --project tsconfig.json --expr \
  'from ts({ uri: "src/index.ts" }) | select "ts::identifier ->ts::symbol ts::identifier"'
ast apply --project tsconfig.json --file rename.dsl --yes --allow-destructive
```

Without either setting, TypeScript remains syntax-only and emits
`ts.syntax-only` information when a file is opened; it never invents
`ts::symbol` edges. Explain output and the `ts` rows from `schema` and `plugins`
report `syntax-only` or `configured-project` without source contents.

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

## Tree-sitter grammars

`createTreeSitterAdapter` exposes read-only syntax from the pinned
[`tree-sitter-language-pack`](https://github.com/xberg-io/tree-sitter-language-pack)
WASM package. The shipped registry contains 31 distinct grammars: Bash, C, C++,
C#, CSS, Dockerfile, Elixir, Erlang, Go, Haskell, HTML, Java, JavaScript, JSON,
Kotlin, Lua, Markdown, PHP, Python, Ruby, Rust, Scala, SQL, Svelte, Swift, TOML,
TSX, TypeScript, Vue, YAML, and Zig. These are the grammars verified in the
installed WASM release, not the larger native language-pack catalog.

Every syntax node has kind `treesitter::node`, with `language`, grammar-native
`type`, `text`, `named`, `missing`, `error`, and `hasError` attributes. A child
also has `field` when its grammar names that relationship. Named nodes and
anonymous punctuation retain source order. Ranges and zero-based columns use
UTF-16 code units, so ranges index the original JavaScript text correctly.

Find Markdown headings anywhere beneath a monorepo, retaining their file paths:

```sh
ast query --expr 'from fs({ uri: ".", include: ["**/*.md"], kinds: ["fs::file"] })
| mount treesitter()
| select "fs::file as $file > treesitter::node treesitter::node[type = \"atx_heading\"]"
| project { file: $file.path, heading: @text }'
```

Direct files use `from treesitter({ uri: "script", language: "python" })`.
Omit `language` to detect a registered filename or extension; supply it for
extensionless files. In TypeScript the same source is
`select(adapter, { uri: "script", options: { language: "python" } }, selector)`.
`mountTreeSitter(files, adapter)` composes with `selectFrom` and the ordered
`[filesystem.schema, adapter.schema]` schema chain.

`treesitter::children` supports forward and reverse syntax navigation. A mounted
root references its containing file through `treesitter::container`. Files are
parsed only when traversal requests their mount. Unknown extensions are skipped
by automatic mounts; direct sources report a missing grammar. Mount read/load
failures warn and skip by default; `onError: "throw"` makes them fail the query.
This includes files changed since their filesystem container was observed or
while their bytes were being read.
Malformed syntax remains queryable with a ranged recovery warning. Binary or
invalid UTF-8 content is not interpreted as text. Semantic edits and TypeScript
symbol analysis remain with their existing adapters.

Custom compatible grammars can extend the library registry with
`createTreeSitterAdapter({ grammars: [...treeSitterGrammars, { name: "custom",
wasm: "/grammars/custom.wasm", extensions: [".custom"] }] })`.
The CLI accepts the corresponding config:

```json
{
  "treeSitterGrammars": [
    { "name": "custom", "wasm": "./grammars/custom.wasm", "extensions": [".custom"] }
  ]
}
```

Config paths resolve relative to the config file. An entry replaces a built-in
grammar with the same name; ambiguous extension or filename registrations are
rejected. Optional `filenames` match exact basenames. Custom WASMs load through
the pinned `web-tree-sitter` runtime and must be compatible with it. Neither
backend downloads grammars during a query.
Custom grammar paths may be relative or absolute local paths (including
Windows drive and UNC paths), or file URLs; remote URI schemes are rejected.

`ast schema treesitter` lists the active grammar registry alongside node and
edge schemas, including configured extension and filename mappings.

The grammar runtime loads on first use. Each opened file buffers its text and
syntax tree, while graph snapshots are created as traversal requests them;
closing the last resource lease frees the tree and its node handles. Identities
include the language, containing file identity, content revision, and child path.
Parsing is synchronous within a file: aborts are observed before and after it,
and throughout asynchronous reading and graph traversal.

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
and adapter operation constructors. Each source declares `selectorSource` as
`"roots"` or `"selection"`; mounts carry an ordered container/mounted schema
chain. Fully namespaced selector steps resolve against their owning adapter
while child traversal can cross the declared mount edge. The built-in
filesystem source is a preselected recursive walk, so a container-prefixed
selector filters its rows without opening mounted resources;
`fs::file > json::root` opens JSON lazily only at the child step. Explanations
label transitions such as `fs -> json`.

```text
from ts({ uri: "src/index.ts" })
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

Projection fields can select related graph values without host callbacks. The
host-reserved `related("one" | "many", selector, expression)` form validates the
selector against the active mounted schema chain. `one` returns missing for no
match and fails on ambiguity; `many` returns an ordered array that preserves
duplicates. Explicit `null` remains distinct from missing, relative selector
captures are available to nested record expressions, and cancellation reaches
the nested graph reads:

```text
from fs({ uri: ".", include: ["**/package.json"], kinds: ["fs::file"] })
| mount json()
| select 'fs::file[name = "package.json"] > json::root'
| project {
    file: @origin.uri,
    name: related("one", 'json::property[name = "name"] > json::scalar', @value),
    dependencies: related("many", 'json::property[name = "dependencies"] > json::object > json::property as $dependency > json::scalar', { name: $dependency.name, version: @value })
  }
```

Each outer row remains streaming. `one` reads at most two relative matches;
`many` buffers only that row's result array. Explanations label these modes, and
the TypeScript `project` callback receives the same active execution options for
equivalent cancellation-aware composition.

Sources, mounts, and operations accept one named argument object. Their
compile-environment schemas validate scalar types, one/many cardinality,
required fields, defaults, allowed choices, and unknown fields before opening a
resource. For example:

```text
from fs({ uri: ".", include: ["**/*.json"], kinds: ["fs::file"] })
| mount json({ onError: "throw" })
| select 'json::root'
```

The CLI exposes every filesystem transformation with its schema-derived
arguments. Content is never implicitly coerced, and binary bytes use base64:

```text
from fs({ uri: ".", include: ["asset.bin"], kinds: ["fs::file"] })
| invoke fs::write { encoding: "base64", content: "AAEC/w==" }
| plan
```

`fs::move` takes `destination`; `fs::remove` takes `{}`; and `fs::create` takes
`name`, `nodeKind` (`"file"` or `"directory"`), plus paired `encoding` and
`content` when initializing a file. Planning remains effect-free, while apply
retains revision checks, absence preconditions, conflict detection, and risk
acknowledgements.

Filesystem explanations report the resolved safe options and pushed filters;
sensitive argument definitions are not generically rendered.

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
ast query --file query.dsl
ast query --expr 'from fs({ uri: "." }) | select "fs::file"'
ast query --file query.dsl --renderer compact
ast plan --stdin --save plan.json < transform.dsl
ast plan --file transform.dsl --diff-provider concise
ast apply --file plan.json --yes --allow-destructive --failure-policy stop
ast explain --file query.dsl
ast schema json
ast plugins
ast --help
ast --version
```

`query`, `plan`, `apply`, and `explain` require exactly one of `--file`,
`--expr`, or `--stdin`. A positional file path remains supported as shorthand
for `--file`, and positional `-` means standard input. Other positional values
are always files, so a typo cannot be reinterpreted as DSL. Diagnostics identify
file programs by their resolved path, inline programs as `argv:program`, and
standard input as `stdin:program`.

Options and positional arguments are command-specific: `plan` alone accepts
`--save`, `apply` alone accepts confirmation, risk acknowledgements, and
`--failure-policy <stop|continue-independent>`, `schema` requires one namespace,
and `plugins` accepts none. Global and
per-command help exit successfully. Unknown, duplicate, missing-value,
irrelevant, and extra arguments emit `cli.usage` and exit 1.

Configured renderer aliases can be selected explicitly for terminal pretty
queries with `--renderer`; configured diff-provider aliases can be selected for
terminal plans with `--diff-provider`. Automation never calls them: JSON Lines
remain canonical and non-terminal plans retain the host renderer. Callbacks see
only host-redacted copies, sensitive previews become `[REDACTED]`, and callback
failures produce `plugin.presentation-failed` without a content-bearing
fallback.

Piped queries emit stable JSON Lines on stdout and diagnostics as separate JSON
Lines on stderr. Terminals default to readable indented values and redacted plan
diffs. Planning cannot apply. Apply never prompts in automation and requires
explicit confirmation plus risk acknowledgements. Its failure policy defaults
to `stop`; `continue-independent` schedules only groups whose dependencies
applied. Pretty and JSON Lines reports keep applied, failed,
`skipped-dependency`, and `skipped-policy` groups distinct and state whether a
failure followed any effects. Acknowledgements cover the plan's risks, while
cancellation interrupts the active adapter, leaves not-yet-started groups
unscheduled, and exits 130. Flags override `AST_*`
environment settings, which override `.astrc.json`. The config file is a closed,
validated object containing only `format`, `color`, `typescriptProject`, `treeSitterGrammars`, and
structurally validated plugin entries; malformed files, invalid environment
enums, unknown fields, and
duplicate plugin identities or aliases emit `cli.invalid-config` and exit 1
before plugin code is loaded.

`ast plugins` reports built-in adapters separately from every loaded plugin
package. Plugin rows include package identity, trust/isolation, required and
approved powers, namespaces, aliases, all manifest contribution lists, and any
adapter compatibility rows, so presentation-only packages remain visible.

Admitted plugin predicates and scalar functions are executable through closed,
typed calls. Predicates are selector pseudos with literal arguments; functions
are DSL expressions and may consume node or capture values:

```text
from demo()
| select 'example::item:minimum(1)'
| project { doubled: twice(@index) }
```

Contributions declare positional scalar parameter types, and functions also
declare one scalar return type. Calls are synchronous deterministic runtime
filters/projections: aliases resolve before execution, explanations show the
canonical name, and they are never reported as adapter pushdown. Unknown,
ill-typed, asynchronous, throwing, or wrong-return callbacks fail with
source-located diagnostics. Missing and `null` remain distinct and are never
implicitly coerced.

Exit codes distinguish usage (1), diagnostics and file-read failures (2),
invalid plans (3), missing confirmation (4), apply failure (5), and
cancellation (130). SIGINT propagates through standard-input reads and
query/apply execution. Rendered values redact conventional secret, token,
password, credential, and API-key fields. Explicitly saved plans contain private
adapter payloads and should be treated as sensitive files.

For `apply`, `--expr` is DSL-only. Plan-shaped JSON from files or standard input
is always passed to the saved-plan loader; incomplete envelopes, malformed
required arrays, bad integrity, and compatibility failures emit
`cli.invalid-plan`, exit 3, and never fall back to DSL or reach effects.

## Architecture conformance

The public-boundary conformance suite demonstrates one repository query mounting
JSON and Markdown, one selector engine across filesystem/document/code nodes,
reference traversal separate from containment, repository-scale early
termination without buffering, pushdown explanations, cancellation cleanup and
I/O timing, deterministic cross-format plans, revision-drift rejection,
adapter-specific operations composed with generic operators, TypeScript/DSL
logical parity, and diagnostics carrying both program and source-node context.

Focused suites additionally cover adapter contracts, selectors, change-group
failure policy, plugin admission, SQL parameterization/transactions, and CLI
automation behavior.

## Development

Requires Node.js 24 or newer and pnpm 11 or newer.

```sh
pnpm install
pnpm check
pnpm build
```
