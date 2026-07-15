---
title: Implement the TypeScript adapter
summary: Expose syntax containment, symbol references, and a small semantic refactoring surface.
depends_on: [change-plans-and-local-apply]
spec_sections: [7.2, 7.3, 17.1, 18.3]
---

# Outcome

TypeScript source files support syntax queries and explicit symbol-reference
edges while semantic changes remain compiler-aware adapter operations.

# Scope

- Project syntax nodes with source ranges and a documented default tree view.
- Add symbol declaration/reference edges when compiler information is available.
- Support a narrowly proven set of operations such as symbol rename and call
  replacement.
- Reuse compiler programs incrementally without exposing mutable compiler nodes.
- Handle syntax errors, project references, generated declarations, JavaScript,
  and files outside a configured project explicitly.

# Acceptance criteria

- Reference traversal is distinct from syntax containment and cycle safe.
- A semantic rename updates proven references rather than text matches.
- Queries remain usable in syntax-only mode when type information is absent.
- Plans include precise source diffs and revision preconditions.
- Performance tests cover multi-file projects without rebuilding per node.
