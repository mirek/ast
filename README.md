# ast

`ast` explores one typed node-graph model, query system, and change-planning
runtime for heterogeneous structured resources such as repositories, source
code, documents, and databases.

The repository contains the architecture specification, implementation backlog,
and a buildable TypeScript monorepo. `@mirek/ast` currently provides the
immutable graph, resource, schema, diagnostic, and capability contracts used by
future adapters and query execution. The query runtime and CLI are not yet
implemented.

Read [SPEC.md](./SPEC.md) for the architecture and [TODO.md](./TODO.md) for the
ordered set of work that remains.

## Workspace

- `@mirek/ast` — pure graph, adapter, query, and change-planning library; its
  foundational model and schema API is available now
- `@mirek/ast-cli` — CLI boundary reserved for later implementation

Both packages remain private until their public names and contracts are
stabilized.

## Development

Requires Node.js 24 or newer and pnpm 11 or newer.

```sh
pnpm install
pnpm check
pnpm build
```
