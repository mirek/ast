# Unified Node Graph Language and Runtime Specification

Status: Draft 0.1  
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
  readonly namespace: string;
  readonly schema: AdapterSchema;
  readonly read?: ReadCapability;
  readonly planning?: PlanningCapability;
  readonly apply?: ApplyCapability;
}
```

Read, planning, and apply are separate structural capabilities. Possessing a
read capability never implies permission to plan or apply effects. Native query
compilation and execution remain provisional extensions to be added only when
the query runtime and adapter evidence require them.

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

### 9.7 Query pipelines

Selectors are embedded in a small pipeline language:

```text
from fs(".")
| select 'fs::file[extension = ".ts"] > ts::source-file ts::call'
| where @callee = "deprecatedApi"
| project { file: @origin.uri, line: @origin.range.startLine }
| sort file, line
```

The exact grammar remains provisional until the TypeScript query algebra has
been validated by multiple adapters.

The initial pipeline operations SHOULD include `select`, `where`, `project`,
`flatMap`, `distinct`, `sort`, `take`, `count`, `group`, and `join`.

## 10. Transformations

Transformations consume selections and emit operations. They do not directly
mutate node handles.

```text
from fs(".")
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
ung query <program> [sources...]
ung plan <program> [sources...]
ung apply <program-or-plan> [sources...]
ung explain <program> [sources...]
ung schema <namespace>
ung plugins
```

`ung` is a placeholder executable name.

Default behavior:

- query results are streamed as JSON Lines when practical;
- terminal output may use a readable table or tree renderer;
- transformations render a plan and diff without applying it;
- applying requires an explicit `apply` command or equivalent flag;
- destructive and irreversible changes are summarized separately;
- diagnostics include DSL locations and source origins;
- secrets and connection values are redacted.

Saved plans MUST include enough adapter version, schema version, resource
identity, and revision information to reject unsafe replay.

The current saved-plan format records the exact schema version of every adapter,
the URI and observed revision of every resource, and an integrity digest over
the complete plan. Source content required for application remains in
adapter-private payloads, while human rendering redacts sensitive previews by
default.

## 14. Plugins

A plugin package MAY contribute:

- one or more adapters;
- node and operation schemas;
- source resolvers;
- parser mounts;
- selector predicates and scalar functions;
- renderers and diff providers;
- optimizer rules limited to declared logical equivalences.

Plugins MUST use globally unique namespaces. Package names are recommended as
the namespace authority, with shorter aliases configured by the user.

Plugins declare required capabilities such as filesystem access, network
access, process execution, credentials, and native modules. Capability approval
and strong isolation are later runtime concerns, but the manifest format MUST
represent them from the beginning.

Plugin APIs follow semantic versioning. Plans record the plugin versions that
created them.

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
specific change.

The runtime SHOULD expose:

- logical and physical query plans;
- which operations were pushed down;
- nodes read and emitted per stage;
- buffered data and memory estimates;
- adapter latency;
- change ordering and transaction boundaries.

Observability MUST avoid logging source contents, credentials, or secrets by
default.

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

Running arbitrary JavaScript plugins is equivalent to running code. Until an
isolation mechanism exists, the CLI MUST state this trust boundary clearly and
SHOULD support an allowlist.

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
   - syntax tree projection;
   - symbol reference edges where compiler information is available;
   - a small set of semantic refactor operations.

YAML, TOML, Git, SQL, and remote-service adapters follow after the contracts
have survived the required adapters.

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

### 17.3 Deliberately deferred

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
from fs(".")
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

A future SQL adapter exposes schema nodes and lazy row selections. A row
predicate is pushed down as SQL, while joins with local configuration use the
runtime planner. Rows are never materialized merely to satisfy the node model.

## 19. Acceptance criteria for the architecture

The core abstraction is considered validated when all of the following are
demonstrated:

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

## 21. Recommended implementation sequence

The active, dependency-aware form of this sequence lives in
[TODO.md](./TODO.md). That index and its files contain only work that remains.

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

The primary limiting factor is not parsing or selector syntax. It is defining
an adapter and change protocol that is uniform enough to compose while still
preserving source-specific semantics, performance, and safety. The implementation
sequence is designed to test that boundary early.
