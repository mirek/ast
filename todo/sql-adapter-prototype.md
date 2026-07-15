---
title: Prototype a SQL adapter
summary: Test whether the graph abstraction remains honest under native query pushdown, joins, transactions, and large unordered data.
depends_on: [stabilize-adapter-contracts]
spec_sections: [7, 8, 11, 17.3, 18.4, 20]
---

# Outcome

A deliberately limited SQL prototype identifies which abstractions generalize
beyond repositories and which must remain adapter specific.

# Scope

- Expose server, database, schema, table, column, relation, and lazy row views.
- Compile safe predicates, projections, ordering, aggregation, and limits to
  parameterized SQL and report pushdown in `explain`.
- Compare native joins with runtime joins to local resources.
- Map transactions, revisions/concurrency controls, partial failures, and row
  identity without implying universal guarantees.
- Record findings as contract or spec changes rather than preserving a demo.

# Acceptance criteria

- Row queries do not materialize tables merely to satisfy the node model.
- Generated SQL is parameterized and covered by adversarial tests.
- Runtime fallback preserves semantics when pushdown is unsupported.
- Transaction and concurrency behavior is explicit in plans.
- The prototype yields a documented keep/change/reject decision for each tested
  extension point.
