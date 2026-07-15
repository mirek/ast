---
title: Implement the selector engine
summary: Parse, validate, and execute the initial CSS-inspired selector subset over typed trees and named graph edges.
depends_on: [query-algebra-and-in-memory-runtime]
spec_sections: [9]
---

# Outcome

Selectors compile into the logical query algebra with typed comparisons,
source-located diagnostics, and no separate execution path.

# Scope

- Support namespaced kind selectors, attribute predicates, child/descendant and
  ordered sibling combinators, named forward/reverse edges, and captures.
- Add `:not`, `:has`, `:is`, explicit null/missing tests, membership, and regular
  expression matching only when their semantics are specified.
- Reject implicit scalar coercion and ambiguous unqualified names.
- Bound transitive or cyclic reference traversal explicitly.
- Preserve source spans from parsing through schema validation.

# Acceptance criteria

- Selector execution over the in-memory adapter matches equivalent TypeScript
  queries.
- Invalid kinds, attributes, comparisons, edge names, capture references, and
  unordered sibling operations produce stable diagnostics.
- Duplicate and ordering behavior matches the specification.
- The grammar remains limited to behavior proven by executable examples.
