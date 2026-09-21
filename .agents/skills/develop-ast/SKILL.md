---
name: develop-ast
description: Implement or change the ast graph model, adapters, query runtime, selectors, change planning, TypeScript API, plugins, or CLI. Use for code tasks in the mirek/ast repository that must follow SPEC.md, the dependency-ordered TODOs, safety invariants, package boundaries, and live-documentation policy.
---

# Develop ast

1. Read `SPEC.md`, `TODO.md`, and the relevant file in `todo/` before designing
   the change.
2. Select one observable vertical slice that respects the task's dependencies;
   avoid abstractions that no current adapter or scenario requires.
3. Add a failing `node:test` case through a public library, adapter, or CLI
   boundary.
4. Implement the smallest immutable, composable change that passes it.
5. Preserve laziness, cancellation, provenance, adapter-owned semantics, pure
   planning, revision checks, and explicit effects wherever they apply.
6. Run `pnpm check` and `pnpm build` from the workspace root.
7. Review every affected Markdown file and repository skill. Update stale
   contracts, examples, commands, package boundaries, and instructions in the
   same pull request.
8. When all acceptance criteria for a TODO are met, delete its file and remove
   its `TODO.md` entry. Never mark completed work as done or retain it in the
   backlog.

Keep process behavior and terminal presentation in `@mirek/ast-cli`. Keep
`@mirek/ast` deterministic and independent of CLI concerns. Prefer Node.js
built-ins and justify runtime dependencies that materially expand the trusted
surface.

Tree-sitter syntax uses the pinned language-pack WASM registry; custom local
WASMs use web-tree-sitter. Verify actual installed grammar coverage, source
coordinates, and explicit tree/node cleanup rather than assuming upstream's
native language catalog matches the WASM build. Keep semantic operations in
their owning adapters. Query projections compose Prelude async transforms while
preserving captures, serial backpressure, and cancellation ownership.

When changing mount resolvers, test directory traversal, container reentry,
embedded mounts, and both orders of stacked adapters. Preserve decoration on
resolved handles without opening a mount until its edge is requested.
Cover reverse mount containment and explicit composite tree views as well;
parent/ancestor navigation must preserve container ownership, and path cycle
pruning must retain duplicates reached through distinct graph paths.
Selector validation for an explicit kind must not borrow attribute declarations
from other kinds; diagnose invalid queries before opening their sources.
When changing adapter caches, test reopened revisions, concurrent mounts, and
earlier handles. TypeScript symbols and rename locations must belong to the
same observed project; refreshes must not retarget an earlier syntax graph.
When changing sources, mounts, or buffering operators, preserve resource
ownership through buffered navigation. Runtime-owned closes use
`closeQueryResource`; buffers collect upstream under `collectWithResources`
and release in `finally`. Test nested buffers, early return, cancellation,
collection failures, and cleanup failures without changing caller signals.
