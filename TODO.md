# Implementation TODOs

This index contains only work that remains. Complete tasks in dependency order
unless a prototype is explicitly intended to answer an earlier design question.
When a task is complete, delete both its file and this index entry rather than
marking it completed.

- [Core model and schema](./todo/core-model-and-schema.md) — define immutable graph, provenance, diagnostics, schema, and capability contracts.
- [Query algebra and in-memory runtime](./todo/query-algebra-and-in-memory-runtime.md) — prove lazy selection semantics with an executable test adapter.
- [Selector engine](./todo/selector-engine.md) — parse, validate, and execute the typed selector subset over tree and reference edges.
- [Filesystem adapter](./todo/filesystem-adapter.md) — stream repository trees with safe read and mutation planning boundaries.
- [JSON adapter and mounting](./todo/json-adapter-and-mounting.md) — prove cross-adapter traversal and faithful ordinary JSON updates.
- [Change plans and local apply](./todo/change-plans-and-local-apply.md) — add pure planning, diffs, conflict detection, revision checks, and explicit application.
- [Markdown adapter](./todo/markdown-adapter.md) — expose semantic sections, document nodes, frontmatter, and fenced-code mounts.
- [TypeScript adapter](./todo/typescript-adapter.md) — expose syntax and symbol graphs plus a small semantic refactoring surface.
- [Stabilize adapter contracts](./todo/stabilize-adapter-contracts.md) — revise the extension contracts using evidence from the required adapters.
- [Textual DSL](./todo/textual-dsl.md) — compile a compact pipeline language into the proven TypeScript query algebra.
- [CLI](./todo/cli.md) — expose query, plan, apply, explain, schema, and plugin workflows safely.
- [Plugin loading and policy](./todo/plugin-loading-and-policy.md) — define manifests, schema discovery, versioning, permissions, and trust boundaries.
- [SQL adapter prototype](./todo/sql-adapter-prototype.md) — pressure-test pushdown, joins, transactions, and abstraction limits.
- [Architecture acceptance](./todo/architecture-acceptance.md) — demonstrate the specification's end-to-end acceptance criteria with bounded-memory tests.
