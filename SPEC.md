# Unified Node Graph Language and Runtime Specification

Status: Architecture validated 0.1; follow-up backlog active; package release pending
Audience: implementers, plugin authors, and users designing structured automation  
Implementation language: TypeScript  

## 1. Summary

This project provides one model and one query-and-transformation system for
working with heterogeneous structured resources.

Source code, documents, directory hierarchies, configuration files, databases,
Git repositories, and external services are exposed as typed, navigable node
graphs. Users select and relate nodes with a terse CSS/XPath-inspired language,
then extract information or construct an explicit change plan.

The system is not based on the claim that every resource is literally an
abstract syntax tree. Instead, every resource is projected into a common typed
graph model with one or more primary tree views. Real domain semantics remain
owned by adapters and their operations.

The TypeScript API is the semantic foundation. The textual DSL is a compact
representation of the same query and transformation plan rather than a
separate execution model.

## 2. Motivation

Structured automation currently requires unrelated tools and programming
models:

- globbing and shell commands for files;
- parser-specific visitors for source code;
- JSONPath, XPath, or bespoke traversal for documents;
- SQL for relational data;
- client libraries for remote services;
- custom coordination code for changes spanning several sources.

These tools are individually effective, but composition is expensive. A task
that renames a TypeScript symbol, updates its YAML configuration, changes its
Markdown documentation, and verifies a database mapping requires multiple
parsers, query systems, mutation APIs, and error models.

This project supplies the missing common layer:

1. adapters project resources into a typed node graph;
2. selectors navigate and relate nodes across adapters;
3. queries remain lazy and can be pushed down to capable sources;
4. transformations produce inspectable changes before causing effects;
5. schemas and provenance make programs diagnosable and safe to compose.

## 3. Goals

The system MUST:

- provide a common representation for heterogeneous structured resources;
- support hierarchical traversal without restricting all data to strict trees;
- provide concise, namespaced selectors inspired by CSS and XPath;
- support extraction, filtering, projection, aggregation, and joins;
- support semantic transformations through adapter-defined operations;
- represent mutations as explicit, previewable change plans;
- evaluate lazily and avoid materializing complete sources by default;
- allow adapters to push predicates, projections, limits, and ordering into
  their native query engines;
- preserve node identity, source provenance, and source revisions;
- expose the complete model as a composable TypeScript library;
- permit plugins written in JavaScript or TypeScript;
- provide a CLI suitable for interactive use and automation;
- behave deterministically when the underlying sources are unchanged.

The initial implementation SHOULD make repository-scale automation excellent
before adding databases or remote systems.

## 4. Non-goals

The initial system is not intended to:

- replace general-purpose programming languages;
- force every domain into a lowest-common-denominator mutation API;
- guarantee atomic commits across unrelated external systems;
- materialize databases or large repositories as in-memory trees;
- define a universal serialization format for every resource;
- infer domain semantics from generic node attributes;
- replace native query languages when they are a better direct interface;
- provide an unrestricted plugin security boundary in the first release.

## 5. Design principles

### 5.1 Everything is a typed node graph

ASTs, directory trees, document trees, relational schemas, and remote resources
are views over a common graph. A node has a type, attributes, identity,
provenance, and edges.

### 5.2 Trees are views; graphs are the model

Primary `child` edges provide predictable CSS-like traversal. Named reference
edges represent imports, symbols, symlinks, foreign keys, dependencies, and
other non-owning relationships.

### 5.3 Queries are pure; effects are planned

Reading and constructing a plan MUST NOT mutate a source. Effects occur only
when an explicit apply operation executes an accepted plan.

### 5.4 Domain semantics are preserved

Generic operations cover navigation and data processing. Semantic mutations
belong to adapters. Renaming a TypeScript symbol is not equivalent to changing
the text of one identifier node.

### 5.5 Lazy by default

Nodes and edges are retrieved on demand. Adapters may return cursors, streams,
or native query handles. Query planning minimizes source reads and memory use.

### 5.6 Provenance is never incidental

Every addressable node identifies its adapter, resource, logical location, and
observed revision when the source provides one.

### 5.7 Namespaces prevent false uniformity

Node kinds and operations use adapter namespaces such as `fs::file`,
`ts::function`, and `sql::row`. An unqualified convenience name may resolve only
when it is unambiguous.

### 5.8 Safe defaults

The CLI previews changes by default. Destructive or irreversible operations
require explicit application and MUST be identified in the plan.

## 6. Conceptual model

### 6.1 Resource

A resource is an adapter-owned source of nodes, such as a directory, file,
database connection, Git repository, or HTTP endpoint.

Resources have stable runtime identifiers and MAY expose a revision used for
optimistic concurrency control.

The public resource descriptor is an immutable value containing an adapter
namespace, runtime identifier, URI, and optional revision. A revision is an
opaque token observed when the resource was opened. Revisions are equal only
when their strings are exactly equal; no lexical ordering or numeric meaning is
implied. Resource handles keep lifecycle capabilities such as `close` separate
from the descriptor.

### 6.2 Node

A node is an immutable observation of part of a resource.

```ts
export type Scalar = string | number | boolean | bigint | null;

export interface NodeId {
  readonly adapter: string;
  readonly resource: string;
  readonly local: string;
}

export interface SourceRange {
  readonly start: number;
  readonly end: number;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface Origin {
  readonly uri: string;
  readonly revision?: string;
  readonly range?: SourceRange;
}

export interface NodeSnapshot {
  readonly id: NodeId;
  readonly kind: `${string}::${string}`;
  readonly attributes: Readonly<Record<string, Scalar | readonly Scalar[]>>;
  readonly origin?: Origin;
}
```

`NodeId` identifies a logical node within an observed resource revision. It is
not required to survive arbitrary external rewrites. Adapters MUST document
their identity guarantees. Node identities are equal when all three `adapter`,
`resource`, and `local` fields are exactly equal within the same observed
revision. JavaScript object identity has no semantic meaning.

Source-backed addressable nodes MUST carry an origin. Synthetic nodes MAY omit
it only when no source location exists; derived nodes SHOULD retain the most
specific available origin. Source ranges are half-open (`start <= offset < end`)
and adapters MUST document their offset coordinate system.

Node kinds, edge names, operation kinds, and tree-view names are namespaced.
The TypeScript template-literal type preserves names statically, while public
definition helpers also reject malformed or unqualified names at runtime.
Each node kind belongs to the adapter recorded in that node's identity.
Definition helpers detach and recursively freeze graph values so callers cannot
retain mutable parser or adapter state through public observations.

An absent attribute is the missing value. It is distinct from an attribute
whose value is explicit `null`. Equality of scalar attributes follows exact
JavaScript primitive equality without implicit string, number, boolean, or
`bigint` coercion; array values compare element-by-element when an operator
requires value equality.

Large values, binary data, and recursively structured values SHOULD be exposed
as child nodes or lazy properties instead of embedded attributes.

### 6.3 Edge

```ts
export interface Edge {
  readonly name: `${string}::${string}`;
  readonly role: "child" | "reference";
  readonly from: NodeId;
  readonly to: NodeId;
  readonly ordinal?: number;
  readonly attributes?: Readonly<Record<string, Scalar>>;
}
```

Child edges define containment and ordering. Within a single tree view, a node
SHOULD have one parent. Reference edges may be cyclic and many-to-many.

An adapter MAY expose multiple named tree views. For example, TypeScript may
offer syntax containment and symbol containment. One view is the default for
unqualified child traversal.

### 6.4 Node handle

A node handle combines a snapshot with lazy access to its edges and
adapter-owned capabilities. Handles MUST NOT expose mutable backing objects.

### 6.5 Selection

A selection is a lazy asynchronous sequence of node handles or derived values
with a declared `stable` or `unknown` ordering guarantee. Selection operators
preserve streaming unless their semantics require buffering, as with a global
sort.

### 6.6 Capture

A query can bind nodes or scalar expressions to named captures. Captures are
lexically scoped and allow later predicates, joins, projections, and
transformations to refer to earlier results.

### 6.7 Operation, change, and plan

An operation expresses user intent. The responsible adapter translates it into
one or more changes. A plan is a validated, ordered collection of changes plus
preconditions and safety metadata.

```ts
export type ChangeRisk = "safe" | "destructive" | "irreversible";

export interface ChangePrecondition {
  readonly resource: string;
  readonly uri: string;
  readonly expectedRevision?: string;
  readonly expectation: "exists" | "absent";
  readonly description: string;
}

export interface Change {
  readonly adapter: string;
  readonly resource: string;
  readonly resourceUri: string;
  readonly resourceRevision?: string;
  readonly kind: `${string}::${string}`;
  readonly risk: ChangeRisk;
  readonly summary: string;
  readonly reversible: boolean;
  readonly payload: unknown;
  readonly preconditions: readonly ChangePrecondition[];
  readonly regions: readonly ChangeRegion[];
  readonly preview?: TextChangePreview;
  readonly transaction?: ChangeTransaction;
}

export interface ChangePlan {
  readonly formatVersion: "1";
  readonly adapters: readonly PlanAdapterIdentity[];
  readonly resources: readonly PlanResourceIdentity[];
  readonly changes: readonly PlannedChange[];
  readonly diagnostics: readonly Diagnostic[];
  readonly transactionGroups: readonly TransactionGroup[];
}
```

The `payload` is adapter-private and MUST be JSON-serializable when a plan is
saved. Regions are normalized URIs with optional half-open source ranges; they
exist for generic conflict detection and do not replace adapter-owned payload
semantics. Text previews are sensitive by default and render as redacted unless
the caller explicitly opts into source content.

Plans assign deterministic operation, change, and transaction-group IDs. They
record exact adapter schema versions and resource identities. The saved-plan
envelope includes an integrity digest; loading validates the format, digest,
adapter versions, internal identities, and any caller-supplied current resource
identities before replay is allowed.

## 7. Adapter model

An adapter owns resource discovery, node projection, query optimization,
operations, change planning, and application for a domain.

```ts
export interface ReadCapability {
  open(
    source: SourceDescriptor,
    context: OpenContext,
  ): Promise<ResourceHandle>;

  roots(
    resource: Resource,
    request: RootRequest,
  ): AsyncIterable<NodeSnapshot>;

  edges(
    node: NodeId,
    request: EdgeRequest,
  ): AsyncIterable<Edge>;

  hydrate(
    ids: readonly NodeId[],
    projection: AttributeProjection,
  ): Promise<readonly NodeSnapshot[]>;
}

export interface PlanningCapability<
  Input extends Operation = Operation,
  Planned = unknown,
> {
  plan(operation: Input, context: PlanContext): Promise<readonly Planned[]>;
}

export interface ApplyCapability<Planned = unknown, Result = unknown> {
  apply(changes: readonly Planned[], context: ApplyContext): Promise<Result>;
}

export interface Adapter {
  readonly contractVersion: "1";
  readonly namespace: string;
  readonly schema: AdapterSchema;
  readonly read?: ReadCapability;
  readonly planning?: PlanningCapability;
  readonly apply?: ApplyCapability;
  readonly mount?: MountCapability;
  readonly diagnostics?: () => readonly Diagnostic[];
}
```

Read, planning, and apply are separate structural capabilities. Possessing a
read capability never implies permission to plan or apply effects. The SQL
prototype demonstrates native query compilation as an adapter-specific typed
source layered over `Query`; it does not add native compilation to the generic
adapter contract or attempt to translate arbitrary callback operators.

Contract version 1 stabilizes resource cleanup, roots and tree views, hydration,
edge reads, planning, explicit apply, diagnostics, and nested mount opening as
focused capabilities. Tree-view choice is a typed source field. Adapter-specific
statistics, native query compilation, cost estimation, and watch support remain
adapter-specific or provisional. Validation rejects capability/schema
mismatches before execution;
compatibility requires contract version, namespace, and schema version equality.

### 7.1 Capabilities

Adapters declare capabilities rather than relying on runtime probing. Relevant
capabilities include:

- tree and reference traversal;
- predicate, projection, sort, aggregation, join, offset, and limit pushdown;
- stable ordering;
- watch or incremental update support;
- semantic operations;
- transactions;
- rollback or compensation;
- revision checks;
- parallel reads or writes.

The planner MUST preserve query semantics when pushdown is unavailable.

### 7.2 Nested adapters

An adapter may mount another adapter beneath one of its nodes. For example:

- `fs::file[path$=".ts"]` can mount a TypeScript syntax tree;
- `fs::file[path$=".md"]` can mount a Markdown document tree;
- a Markdown fenced code block can mount a language-specific AST;
- an archive file can mount another filesystem view.

Mounting MUST preserve a path back to the containing node and the original
resource provenance.

The proven local JSON mount represents the mount itself as a stable child edge
from `fs::file` to `json::root`. The root has exactly one child: the parsed JSON
value. It also exposes a separate `json::container` reference edge back to the
file, so containment remains acyclic while queries can recover ownership.
Requesting the mount edge opens and parses the nested resource lazily; merely
discovering or yielding the file does not read its bytes. The mounted resource
is owned by that edge traversal, remains available while its descendants are
consumed, and closes on completion, failure, cancellation, or early return.
Mounted node identity combines the containing file identity with a source-order
structural path and is stable only within the observed file revision.

The Markdown adapter follows the same lazy file-mount lifecycle. Its default
`markdown::syntax-tree` preserves source-order blocks; the explicit
`markdown::section-tree` derives nested sections from heading levels. Selector
compilation accepts a tree-view option and uses only that view's declared child
edges. A JSON fenced block may expose a read-only `json::mount`; its JSON root
references the `markdown::code-block`, and that block references the original
filesystem file. Embedded-format edits must be expressed through the containing
document adapter until it can map nested patches safely.

The TypeScript adapter mounts `ts::source-file` beneath filesystem files and
uses `ts::children` only for compiler syntax containment. In configured-project
mode, `ts::symbol` is a separate reference edge from identifiers to compiler-
proven declarations; it is never treated as a child edge. One cached language
service supplies all files in a project. Without a configured project, files
remain queryable in syntax-only mode and expose no invented symbol edges.

### 7.3 Adapter-specific operations

Adapters publish typed operations such as:

- `fs.move`, `fs.remove`, and `fs.write`;
- `ts.renameSymbol` and `ts.organizeImports`;
- `markdown.setHeading`;
- `sql.updateRows` and `sql.deleteRows`.

Generic structural rewrites MAY be supported by adapters that can serialize
them faithfully. They MUST NOT be assumed for every node kind.

## 8. Schema and type system

Each adapter publishes a schema describing:

- node kinds;
- attributes and scalar types;
- child and reference edge names;
- allowed parent-child relationships where known;
- supported operations and their arguments;
- identity and ordering guarantees;
- available tree views;
- relevant capabilities.

The TypeScript API derives static types from installed adapter schemas when
possible. The textual DSL is checked during compilation or before execution.

Unknown plugin schemas MAY be loaded dynamically. In that case, the runtime
still performs schema validation and reports source-located diagnostics.

Schemas describe the exposed logical model, not necessarily the physical
storage schema. A SQL adapter, for example, may expose server, database,
schema, table, column, relation, and row node kinds.

The current serializable schema contract contains a namespace and version;
node-kind, attribute, edge, operation-argument, and tree-view descriptions;
identity and ordering guarantees; and declared capabilities. A schema owns the
names it defines, permits at most one default tree view, and cannot contain
duplicate definitions. Static schemas use `dynamic: false`. Runtime-loaded
plugin schemas use the explicit `dynamic: true` escape hatch but remain subject
to the same runtime structural and namespace validation.

## 9. Selector language

The selector language borrows familiarity from CSS but is designed for typed,
namespaced graphs.

### 9.1 Core selectors

```text
fs::file
fs::file[extension = ".ts"]
ts::function[name ^= "parse"]
markdown::heading[level <= 2]
```

Supported attribute operators SHOULD include:

- equality and inequality: `=`, `!=`;
- comparison: `<`, `<=`, `>`, `>=`;
- string operations: `^=`, `$=`, `*=`;
- existence: `[attribute]`;
- membership: `in`;
- regular expression matching through an explicit function or operator.

Expressions MUST use typed comparison. Implicit coercion between strings,
numbers, and booleans is forbidden.

The initial executable subset uses scalar literals (`string`, `number`,
`bigint`, `boolean`, and `null`), `in (...)` membership, `/pattern/flags`
regular expressions with `~=`, `[attribute is null]`, and
`[attribute is missing]`. For multi-valued attributes, positive comparisons
match when any value matches; `!=` matches only when no value equals the
operand. `*=` is string containment for scalar strings and membership for
multi-valued attributes. Relational operators are invalid for booleans and
nulls.

### 9.2 Tree combinators

```text
A > B        direct child
A B          descendant
A + B        immediately following sibling
A ~ B        following sibling
```

Sibling combinators are available only for ordered child edges.

### 9.3 Named edges

Reference traversal is explicit:

```text
ts::identifier ->ts::symbol ts::declaration
sql::row ->sql::foreign-key sql::row
fs::symlink ->fs::target fs::entry
```

Reverse traversal uses `<-edge`:

```text
ts::function <-ts::calls ts::call
```

Cycles are not followed recursively unless the query explicitly requests a
bounded or cycle-safe transitive traversal.

Kind and edge names in the executable selector subset are always fully
namespaced. Named-edge combinators are single-hop; recursive reference
traversal remains available only through the query algebra's explicit bounded
`traverse` operator.

### 9.4 Predicates

The initial selector set SHOULD support:

- `:not(selector)`;
- `:has(relative-selector)`;
- `:is(selector-list)`;
- adapter-defined, schema-declared predicates;
- boolean scalar expressions;
- explicit null and missing-value tests.

The executable subset supports `:not`, `:is`, and `:has`. A relative selector
inside `:has` may begin with a combinator; without one it means descendant
matching. Nested selectors are compiled from the same query operators as
top-level selectors.

### 9.5 Captures

```text
ts::function as $function
  ts::call[callee = "deprecated"] as $call
```

Captures can be projected as structured output or consumed by a transformation.

### 9.6 Ordering and duplicates

Every adapter documents whether a traversal has stable native order. The query
engine MUST NOT invent meaningful order for unordered sources.

Selections use bag semantics by default because separate paths may reach the
same node. `distinct` removes duplicates by `NodeId`. An explicit `sort`
establishes derived order and may require buffering.

Selector compilation distinguishes resource-root inputs from preselected node
streams. Root inputs expand through the selected tree view before matching;
preselected streams match their existing rows without recursively walking each
row again. This distinction prevents a recursive adapter source from inventing
extra paths while preserving duplicates produced by distinct source or graph
paths.

### 9.7 Query pipelines

Selectors are embedded in a small pipeline language:

```text
from fs({ uri: ".", include: ["**/*.ts"], kinds: ["fs::file"] })
| mount ts()
| select 'fs::file[extension = ".ts"] > ts::source-file ts::call'
| where @callee = "deprecatedApi"
| project { file: @origin.uri, line: @origin.range.startLine }
| sort file, line
```

The grammar below follows the TypeScript algebra validated across the required
local adapters; additions must preserve compilation to that same algebra.

The initial textual pipeline includes `select`, `where`, `project`, `distinct`,
`sort`, `take`, `count`, and equality `join`. The TypeScript algebra additionally
retains callback-based `flatMap` and `groupBy`.

The validated initial textual grammar is expression-only:

```text
program     := ("let" name "=" pipeline ";")* pipeline
pipeline    := from-step ("|" step)*
from-step   := "from" name "(" argument-object? ")"
step        := "mount" name "(" argument-object? ")"
             | "select" quoted-selector
             | "where" expression comparison expression
             | "where" expression "is" ("null" | "missing")
             | "project" "{" projection-list? "}"
             | "distinct" | "sort" name-list | "take" integer | "count"
             | "join" name "on" expression "=" expression
             | "invoke" namespaced-name "{" argument-list? "}"
             | "plan"
expression  := literal | "@" path | "$" name ("." path)?
argument-object := "{" argument-list? "}"
argument-list   := name ":" argument-value ("," name ":" argument-value)*
argument-value  := literal | "[" literal-list? "]"
```

Literals are quoted strings with explicit escapes, finite numbers, `bigint`
literals, booleans, and `null`. Selectors retain their existing regular-
expression, null, missing, and capture syntax. `@path` reads the current node or
derived value; `$capture.path` reads a selector capture; `$left` and `$right`
address equality-join members. Bindings are lexical query values, cannot be
recursive or effectful, and must precede their use. Joins are inner equality
joins from the existing query algebra.

`invoke` must be followed immediately by terminal `plan`. Source, mount, and
operation names are resolved only through an explicit compile environment.
Every source resolver declares whether it returns resource roots or a
preselected stream. A mount begins a new rooted graph for its target adapter;
therefore a selector after `mount` traverses the mounted tree, while a selector
directly after the built-in recursive filesystem source matches the walked
stream as-is. The TypeScript `selectFrom` API exposes the same choice through
`sourceMode`, so textual and programmatic queries retain identical plans.
Source resolvers and mounts also publish one serializable named-argument schema.
Each field declares its scalar type, `one` or `many` cardinality, whether it is
required, and optional default, allowed choices, and sensitivity. Compilation
rejects missing, unknown, duplicate, ill-typed, wrong-cardinality, and
disallowed arguments with the field's program span before opening a resource.
Resolved arrays and defaults are immutable. Physical explanations show safe
resolved built-in options and native pushdowns; sensitive fields are never
rendered by the generic compiler.
There are deliberately no imports, modules, user functions, loops, arbitrary
code evaluation, general recursion, or privileged execution path. Operations
not representable through declarative scalar expressions, including general
`flatMap` and grouping callbacks, remain TypeScript-API-only until proven syntax
exists. Formatting is deterministic and preserves a source span for every
binding, pipeline, and step. Nested selector diagnostics are translated back to
their containing DSL spans.

## 10. Transformations

Transformations consume selections and emit operations. They do not directly
mutate node handles.

```text
from fs({ uri: ".", include: ["**/*.ts"], kinds: ["fs::file"] })
| mount ts()
| select 'fs::file[extension = ".ts"] ts::identifier[name = "oldName"]'
| invoke ts::renameSymbol { name: "newName" }
| plan
```

An adapter operation receives node identities, captured values, arguments, and
observed revisions. It returns changes with preconditions.

### 10.1 Generic transformations

The core MAY define generic operations for adapters that explicitly advertise
support:

- set or remove an attribute;
- insert, replace, move, or remove a child;
- construct a node;
- copy a subtree.

Supporting a generic operation means the adapter guarantees a semantically
valid serialization or rejects the individual request with a diagnostic.

### 10.2 Plan phases

Planning proceeds through these phases:

1. evaluate the selection against observed revisions;
2. expand operations into adapter-owned changes;
3. detect conflicting changes to the same logical regions;
4. order dependencies between changes;
5. establish transaction groups;
6. validate preconditions and adapter policies;
7. render a summary and source-specific diff where possible.

Planning MUST remain free of externally visible mutations.

The executable planner accepts explicitly identified operations and dependency
IDs. Adapter planning runs in deterministic dependency order. Overlapping whole
resources or half-open source ranges produce error diagnostics; a plan with any
error diagnostic cannot be applied. Non-overlapping JSON patches against one
observed document share one local atomic transaction group.

### 10.3 Applying a plan

Before applying a transaction group, the runtime checks its preconditions.
Revision mismatches fail rather than silently overwriting newer state.

Adapters with native transactions apply a group transactionally. For other
adapters, the plan explicitly reports partial-application risk and available
compensation actions.

The runtime MUST stop scheduling changes that depend on a failed change. It MAY
continue independent groups only when the user selected that policy.

`applyChangePlan` is the sole core effect boundary. The default failure policy
stops later independent groups after a failure; `continue-independent` permits
only groups whose dependencies succeeded. Results distinguish applied, failed,
dependency-skipped, and policy-skipped groups and report whether any effects
preceded a failure. Every adapter revalidates existence and exact opaque
revisions immediately before effects. JSON applies one document group through a
same-directory atomic replacement; filesystem changes validate a group before
executing and advertise no rollback or compensation where none exists.

## 11. Query planning and execution

The runtime compiles TypeScript calls or textual DSL into one logical query
algebra.

The planner:

1. validates node kinds, attributes, edges, and operations against schemas;
2. resolves namespaces and mounted adapters;
3. identifies query fragments supported natively by adapters;
4. pushes down safe filters, projections, ordering, aggregation, and limits;
5. chooses join strategies based on capabilities and optional cost estimates;
6. inserts buffering only where required;
7. produces an explainable physical plan.

Adapters MAY provide cardinality and cost estimates. Correctness MUST NOT
depend on accurate estimates.

Execution uses `AsyncIterable` semantics and honors backpressure. Cancellation
propagates to adapters. Resources MUST be closed when a query completes, fails,
or is cancelled.

The SQL prototype's `fromSqlRows` source accepts a serializable table,
predicate, projection, ordering, aggregation, inner-equality-join, offset, and
limit description. It compiles identifiers only after catalog resolution,
places every scalar value in a parameter array, streams the client's
`AsyncIterable`, and exposes the generated statement and pushed operators in
`explain`. A callback-only predicate remains a runtime `filter`; a dependent
limit remains a runtime `take`, so fallback cannot change filter-before-limit
semantics. Native joins are explicit, while joins to local resources continue
to use the buffering runtime equality join. No automatic cost-based choice is
claimed.

The prototype uses quoted identifiers and PostgreSQL-style numbered parameter
positions as its concrete pressure-test dialect. A production client owns
dialect translation. The injected client's `transaction` method MUST either
commit every supplied statement atomically or reject; the adapter does not
simulate rollback around a non-transactional client.

## 12. TypeScript API

The programmatic API is the reference interface.

```ts
const files = workspace
  .from(fs.directory("."))
  .select(fs.file.where({ extension: ".ts" }))
  .mount(ts.sourceFile())
  .select(ts.call.where({ callee: "deprecatedApi" }));

const report = await files
  .project(call => ({
    file: call.origin.uri,
    line: call.origin.range?.startLine,
  }))
  .toArray();

const plan = await files
  .invoke(ts.replaceCall({ callee: "replacementApi" }))
  .plan();
```

The API SHOULD favor immutable query values, small composable operators, and
schema-derived types. It MUST allow escape hatches for dynamically loaded
schemas without making the common typed path cumbersome.

Textual DSL compilation produces the same logical query objects used by this
API. Neither interface receives privileged runtime behavior.

## 13. CLI

The CLI SHOULD support:

```text
ast query <program>
ast plan <program> [--save plan.json]
ast apply <program-or-plan> --yes [risk acknowledgements]
ast explain <program>
ast schema <namespace>
ast plugins
```

The executable and product name is `ast`; the package remains
`@mirek/ast-cli` while private.

Default behavior:

- query results are streamed as JSON Lines when practical;
- terminal output may use a readable table or tree renderer;
- transformations render a plan and diff without applying it;
- applying requires an explicit `apply` command or equivalent flag;
- destructive and irreversible changes are summarized separately;
- diagnostics include DSL locations and source origins;
- secrets and connection values are redacted.

Non-terminal query output is stable JSON Lines: data uses stdout and diagnostics
use stderr. Terminals default to indented readable output, while plan previews
use risk labels and redacted text diffs. `--format` overrides `AST_FORMAT`, which
overrides `.astrc.json`, then terminal-sensitive defaults. `NO_COLOR` overrides
color configuration; the initial renderer emits no ANSI color.

`plan` only previews and optionally saves. Non-interactive apply never prompts
and requires `--yes`, plus `--allow-destructive` or `--allow-irreversible` for
those risks. Saved-plan envelopes are recognized strictly and cannot fall back
to DSL after integrity or compatibility failure. SIGINT cancels through an
`AbortSignal` and exits 130.

Exit statuses are 0 success, 1 usage/configuration, 2 execution or diagnostic
error, 3 invalid plan, 4 missing confirmation/policy acknowledgement, 5 apply
failure, and 130 cancellation. Query warnings may accompany successful data;
errors retain streamed output but return 2. Rendered values redact conventional
secret/key fields. Explicit saved-plan files contain adapter-private payloads
and MUST be handled as sensitive artifacts.

Saved plans MUST include enough adapter version, schema version, resource
identity, and revision information to reject unsafe replay.

The current saved-plan format records the exact schema version of every adapter,
the URI and observed revision of every resource, and an integrity digest over
the complete plan. Source content required for application remains in
adapter-private payloads, while human rendering redacts sensitive previews by
default.

## 14. Plugins

A JavaScript or TypeScript plugin module exports a plugin object as its default
export or named `plugin` export. Its immutable manifest contains:

- plugin API version, package name, semantic version, and a build-integrity
  identifier;
- every globally unique namespace owned by the package;
- required powers;
- exact contribution-name lists for adapters, dynamic schemas, source
  resolvers, mounts, operations, predicates, scalar functions, renderers, diff
  providers, and optimizer rules.

The corresponding contribution object MAY provide:

- one or more adapters;
- node and operation schemas;
- source resolvers;
- parser mounts;
- selector predicates and scalar functions;
- renderers and diff providers;
- optimizer rules limited to declared logical equivalences.

Each source-resolver contribution declares `selectorSource` as `roots` or
`selection`; the host carries that scope into selector compilation instead of
guessing from the returned query.
Resolver and mount contributions use the same serializable named-argument
schema as built-ins. Plugin registration rejects malformed schemas before an
alias can expose the contribution.

Every contribution name is namespace-owned. Runtime-loaded schemas MUST declare
`dynamic: true`, pass the normal schema validation, and exactly match the schema
carried by their adapter. Manifest lists and actual contributions MUST match.
Duplicate package names, namespaces, contribution names, reserved built-in
namespaces, or aliases fail registration before any contribution is used.

The initial optimizer extension surface accepts only the closed `identity`
equivalence and no executable rewrite callback. More equivalences require core
definitions that preserve bag semantics, ordering, captures, cancellation, and
errors; a plugin cannot merely assert that an arbitrary rewrite is safe.

Plugin policy contains an explicit package allowlist, approved powers per
package, reserved host namespaces, and optional aliases. Aliases are configured
separately for namespaces, sources, mounts, operations, predicates, functions,
renderers, and diff providers. The textual DSL consumes explicit source, mount,
and operation aliases; canonical contribution identity remains namespaced.

Required powers distinguish resource read/write, filesystem read/write, network
read/write, process execution, credential reads, and native-module loading.
Registration rejects a plugin when any declared power is unapproved. This is
admission policy for trusted code, not operating-system enforcement: plugin code
can perform any action available to the hosting Node.js process.

Plugin APIs and package versions follow semantic versioning. Plans record the
plugin API version, package version, build-integrity identifier, adapter
namespace, and schema version that created each plugin-owned change. Deserialize
and apply reject any mismatch. Build integrity is declared by trusted plugin
code and detects identity drift; it is not independent attestation of module
bytes.

## 15. Diagnostics and observability

Diagnostics have a stable code, severity, message, and zero or more locations.

```ts
export interface Diagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly locations: readonly DiagnosticLocation[];
  readonly notes?: readonly string[];
}
```

Locations may reference the DSL program, a source node, an adapter, or a
specific change. Diagnostics produced while planning a textual DSL operation
retain adapter-provided node/source locations and add the invoking program span;
program context never replaces source provenance.

The runtime SHOULD expose:

- logical and physical query plans;
- which operations were pushed down;
- nodes read and emitted per stage;
- buffered data and memory estimates;
- adapter latency;
- change ordering and transaction boundaries.

Observability MUST avoid logging source contents, credentials, or secrets by
default.

The current physical plan marks buffering operators and adapter pushdowns.
Filesystem statistics expose opened/closed resources, directories and entries
read, nodes observed, I/O operation count, and cumulative I/O duration. The
clock is injectable for deterministic conformance tests. Repository-scale early
termination demonstrates a streaming, non-buffering pipeline and balanced
cleanup under normal return and cancellation.

## 16. Security model

Read and write capabilities are distinct. Opening a resource for querying does
not grant permission to change it.

The runtime MUST:

- distinguish pure adapters from effectful adapters;
- require explicit credentials and capabilities per resource;
- redact declared sensitive attributes;
- prevent query rendering from accidentally serializing secrets;
- identify external process and network effects in plans;
- permit policy checks before plan application.

Running arbitrary JavaScript plugins is equivalent to running code. The CLI
imports only modules explicitly listed in configuration with an expected
package name, approved powers, and aliases, then validates their manifests
before using contributions. Module top-level code necessarily runs during
import, before its exported manifest can be checked. `ast plugins` reports
external modules as trusted and not isolated. No sandbox, power-level syscall
enforcement, credential broker, or module-byte attestation currently exists.

## 17. Initial scope

The first useful release targets local, version-controlled repositories.

### 17.1 Required adapters

1. Filesystem
   - directories, files, and symlinks;
   - lazy walking with glob and metadata predicate pushdown;
   - write, move, remove, and create plans.
   - node identity is the normalized root-relative path within an observed
     revision; origins use file URIs and opaque `lstat`-derived revision tokens;
   - directory children use deterministic code-point path ordering, while
     symlink targets are reference edges that child traversal never follows;
   - include/exclude globs, node kinds, size bounds, and modification-time
     bounds may be pushed into walking and MUST remain visible in physical
     explanations;
   - file contents, including large and binary values, remain opaque during
     metadata queries; write/create intent carries explicit UTF-8 or base64
     encoding;
   - filesystem operation planning observes revisions and destination
     constraints but performs no effects. Application belongs to the explicit
     change-plan runtime.
   - statistics expose I/O counts and cumulative duration without source
     contents; an injectable monotonic clock makes timing instrumentation
     deterministic in tests.
2. JSON
   - object, property, array, and scalar nodes;
   - an explicit root node whose single child is the document value, with
     properties and array indices represented as intermediate child nodes;
   - source-order deterministic traversal, explicit null scalar values, and
     absence represented by a missing property rather than a synthetic value;
   - lazy `json::mount` child edges from filesystem files and a
     `json::container` reference path back to the owning file;
   - UTF-8 and UTF-8-with-BOM observations with UTF-16 source offsets after the
     optional BOM, preserving original bytes for no-op edits, final-newline
     behavior, and unrelated source text for localized edits;
   - adapter operations for value replacement, property insertion/removal, and
     array insertion/removal. Planning emits revision-guarded localized text
     patches and never mutates the file;
   - invalid syntax produces source-ranged diagnostics. Mount traversal may
     skip invalid documents so unrelated files remain queryable, or fail under
     an explicit throw policy.
3. Markdown
   - document structure, headings, sections, lists, links, code blocks, and
     frontmatter;
   - source-order syntax containment and heading-based section containment as
     separate named tree views selected explicitly by queries;
   - lazy filesystem mounts and read-only JSON fenced-code mounts with reference
     paths through the code block to the original file;
   - UTF-8 and UTF-8-with-BOM observations with UTF-16 offsets after the optional
     BOM. No-op and localized heading/section edits preserve unrelated bytes,
     newline style, frontmatter, and nested subsections;
   - duplicate headings remain distinct source-order nodes. Skipped levels,
     unclosed fences, and unclosed frontmatter produce ranged diagnostics;
   - inline and reference links resolve to link nodes. Embedded HTML remains an
     opaque paragraph instead of being normalized;
   - the initial loss-aware parser recognizes YAML-delimited frontmatter, ATX
     headings, flat ordered/unordered lists, paragraphs, links, and fenced code.
     Unsupported Markdown constructs remain paragraph text.
4. TypeScript
   - immutable source-file, declaration, call, identifier, import, and generic
     syntax snapshots with UTF-16 compiler source ranges;
   - `ts::children` syntax containment and separate `ts::symbol` reference
     edges where configured-project compiler information is available;
   - lazy filesystem mounts and one reused TypeScript language service per
     adapter/project rather than rebuilding a program per node or file;
   - compiler-proven symbol rename across project files and localized call-
     expression replacement. Both produce exact text previews, opaque revision
     preconditions, and atomic per-file patches;
   - syntax-only TypeScript and JavaScript remain queryable, including malformed
     files with ranged syntax diagnostics. Files outside a configured project
     receive an explicit informational diagnostic and no symbol claims;
   - declaration files are projected with an explicit attribute and remain
     read-only. Initial project references are diagnosed as unsupported rather
     than being loaded partially or silently.

YAML, TOML, Git, production database drivers, and remote-service adapters follow
after the contracts have survived the required adapters. The injected-client
SQL prototype below tests the database boundary without adding a driver.

### 17.2 Required runtime functionality

- typed TypeScript query construction;
- parsing and validation for the selector subset;
- child, descendant, named-edge, predicate, and capture semantics;
- lazy asynchronous execution;
- mounted adapters;
- JSON Lines output;
- operation-to-plan conversion;
- textual diff for local file changes;
- revision preconditions;
- explicit plan application;
- logical and physical plan explanation.

### 17.3 SQL prototype

`createSqlAdapter` accepts a credential-free display URI, an observed catalog,
and an injected client. The catalog graph exposes server, database, schema,
table, column, and relation nodes; relation endpoints are reference edges.
Metadata traversal never scans rows. Catalog-derived `sql::row` schemas describe
known scalar columns, while row scans remain lazy adapter-specific sources.

Primary-key tables use key-derived row identity. Keyless tables use an explicit
query-scoped ordinal and are never presented as persistently identified.
Revision columns provide row-level optimistic predicates where declared;
otherwise a mutation can claim only local transaction isolation. Update/delete
planning is pure and records parameterized statements, catalog revision,
concurrency mode, irreversible risk, and one database-local atomic transaction.
Apply rechecks catalog revision and optimistic affected-row counts before
reporting success. Cross-database or cross-adapter atomicity is not implied.

### 17.4 Deliberately deferred

- distributed execution;
- optimizer cost models beyond simple heuristics;
- cross-resource transaction protocols;
- untrusted plugin sandboxing;
- a language server and visual query builder;
- incremental watch queries;
- database federation;
- general recursion in the textual DSL.

## 18. Example scenarios

### 18.1 Repository inventory

Find package manifests beneath workspace packages and extract package names and
dependencies without custom filesystem and JSON traversal code.

```text
from fs({ uri: ".", include: ["**/package.json"], kinds: ["fs::file"] })
| mount json()
| select 'fs::file[name = "package.json"] > json::root'
| project {
    file: @origin.uri,
    name: child("name").value,
    dependencies: child("dependencies")
  }
```

### 18.2 Cross-format validation

Select service names declared in TypeScript, relate them to YAML deployment
entries, and report declarations without deployments. This requires explicit
value-based joining rather than pretending that the resources share physical
edges.

### 18.3 Semantic refactoring

Select calls to a deprecated TypeScript API, invoke a semantic replacement,
update matching Markdown examples, and produce one plan containing both sets of
file patches.

### 18.4 Database adapter

The SQL prototype exposes catalog nodes and lazy row selections. Declarative row
predicates are pushed into parameterized SQL, while joins with local
configuration use the runtime planner. Rows are streamed and never materialized
merely to satisfy the node model. A production adapter supplies the injected
client, credentials, dialect-specific behavior, and catalog acquisition.

## 19. Acceptance criteria for the architecture

The core abstraction is validated by executable public-boundary conformance
tests. `packages/core/test/architecture.test.mjs` demonstrates the composed
criteria, while focused adapter/query tests retain lower-level failure coverage:

- one query traverses a directory and mounts at least two file-format adapters;
- the same selector engine operates over filesystem, document, and code nodes;
- a reference edge can be traversed without treating it as containment;
- a query over a large directory streams results with bounded memory;
- an adapter successfully pushes down a filter and exposes this in `explain`;
- a cross-format transformation produces one inspectable plan;
- planning performs no source mutation;
- changing a source after planning causes revision validation to reject apply;
- adapter-specific semantic operations coexist with generic query operators;
- TypeScript and textual DSL programs compile to the same logical query model;
- diagnostics identify both the program expression and originating source node.

## 20. Open design questions

These questions should be answered through prototypes rather than syntax-only
design:

1. Should the canonical selector surface be CSS-derived, XPath-derived, or a
   small relational algebra with selector sugar?
2. Which attributes are guaranteed eagerly available for effective planning?
3. Should reference traversal use named edge combinators or explicit pipeline
   operations?
4. How much schema information can remain serializable while still producing
   useful TypeScript inference?
5. What is the smallest operation protocol that supports both text patches and
   transactional database changes honestly?
6. How should plans encode compensation without implying false atomicity?
7. Which stable node identity strategies work across reparses and formatting?
8. Where is the boundary between selector functions and arbitrary user code?
9. Is the textual DSL expression-only, or does it eventually need bindings,
    reusable functions, and modules?

### 20.1 SQL prototype decisions

- **Keep:** catalog structure as ordinary graph nodes and named child/reference
  edges; lazy rows as node handles with catalog-derived dynamic attributes.
- **Keep:** the existing `Query` and change-plan contracts. Native compilation,
  statements, affected-row checks, and local transactions remain adapter-owned
  extensions, so adapter contract version 1 does not change.
- **Keep:** a closed declarative SQL predicate/projection/order/aggregate/join
  source with catalog-resolved identifiers and parameter-only scalar values.
- **Keep:** runtime equality joins for SQL-to-local data and callback fallback
  through ordinary query operators. Limits move to runtime whenever pushing
  them would precede an unsupported filter.
- **Change:** row identity documentation must distinguish primary-key identity
  from query-scoped ordinal identity; a universal stable row ID is rejected.
- **Reject:** raw SQL fragments, callback-to-SQL translation, silent column
  ambiguity across joins, and native limit/offset placement that changes
  fallback semantics.
- **Reject:** automatic native-versus-runtime join selection without a proven
  cost interface, generic row rewrites, or cross-resource transaction claims.
  SQL update/delete stays adapter-specific and reports local rollback,
  optimistic concurrency, and post-commit irreversibility separately.

## 21. Validated implementation sequence

The architecture was implemented and pressure-tested in this dependency order:

1. Implement an in-memory test adapter and executable logical query algebra.
2. Implement filesystem traversal with streaming and predicate pushdown.
3. Implement JSON mounting and prove cross-adapter traversal.
4. Implement plan construction, file diffs, preconditions, and explicit apply.
5. Add Markdown and TypeScript adapters to pressure-test semantic trees and
   reference edges.
6. Stabilize the adapter and operation contracts.
7. Design the textual DSL from the proven TypeScript algebra.
8. Add plugin loading and manifests.
9. Prototype one SQL adapter specifically to test lazy query pushdown, joins,
    transactions, and the limits of the abstraction.

The primary limiting factor was not parsing or selector syntax. It was defining
an adapter and change protocol that is uniform enough to compose while still
preserving source-specific semantics, performance, and safety. This sequence
tested that boundary before architecture acceptance. [TODO.md](./TODO.md)
indexes follow-up correctness and product-surface work discovered through
public CLI and selector exploration.
