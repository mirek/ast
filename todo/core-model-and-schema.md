---
title: Define the core model and schema contracts
summary: Establish immutable graph values, provenance, diagnostics, schemas, capabilities, resources, and adapter-owned operations.
depends_on: []
spec_sections: [5, 6, 7, 8, 15]
---

# Outcome

`@mirek/ast` exposes the smallest stable TypeScript vocabulary needed to build
and test adapters without committing to the textual DSL.

# Scope

- Define scalar values, node identities, origins, source ranges, snapshots,
  child/reference edges, resources, revisions, and node handles.
- Separate read, planning, and apply capabilities into composable interfaces.
- Represent node kinds, attributes, edges, operations, tree views, identity
  guarantees, ordering, and pushdown capabilities in serializable schemas.
- Define source-located diagnostics with stable codes.
- Document equality, identity, missing-value, and revision semantics.

# Acceptance criteria

- Public values are immutable and do not expose mutable parser or adapter state.
- Read access does not imply write access.
- A schema can describe the in-memory test adapter without adapter-specific core
  types.
- Type tests cover namespace-safe kinds, optional provenance, and dynamic-schema
  escape hatches.
- `SPEC.md` examples compile against the resulting names or are updated in the
  same pull request.
