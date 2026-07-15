# ast

`ast` explores one typed node-graph model, query system, and change-planning
runtime for heterogeneous structured resources such as repositories, source
code, documents, and databases.

The repository contains the architecture specification, implementation backlog,
and a buildable TypeScript monorepo. `@mirek/ast` provides immutable graph,
resource, schema, diagnostic, and capability contracts plus an executable lazy
query algebra and selector compiler. The CLI is not yet implemented.

Read [SPEC.md](./SPEC.md) for the architecture and [TODO.md](./TODO.md) for the
ordered set of work that remains.

## Workspace

- `@mirek/ast` — pure graph, adapter, query, and change-planning library; its
  model, schema, lazy query runtime, explain plans, and in-memory adapter are
  available now, together with selector parsing, schema validation, and query
  compilation
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

## Development

Requires Node.js 24 or newer and pnpm 11 or newer.

```sh
pnpm install
pnpm check
pnpm build
```
