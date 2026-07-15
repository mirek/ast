---
title: Build the logical query algebra and in-memory runtime
summary: Validate ordered lazy selections, captures, projections, joins, cancellation, and resource cleanup without I/O complexity.
depends_on: [core-model-and-schema]
spec_sections: [6.4, 6.5, 6.6, 11, 12]
---

# Outcome

TypeScript programs construct immutable logical queries that execute against a
small in-memory adapter through `AsyncIterable` semantics.

# Scope

- Implement roots, traversal, filtering, projection, flat mapping, distinct,
  take, count, grouping, sorting, captures, and joins as logical operators.
- Preserve streaming except where semantics require buffering.
- Propagate backpressure, cancellation, errors, and resource closure.
- Add an in-memory adapter and fixtures for ordered trees, unordered graphs,
  cycles, duplicates, reference edges, and revisions.
- Expose a logical and physical plan representation suitable for `explain`.

# Acceptance criteria

- Tests demonstrate bag semantics, explicit distinctness, stable versus unknown
  ordering, capture scope, bounded traversal, and deterministic results.
- `take` can stop an upstream source without materializing remaining nodes.
- Global sort clearly reports buffering in the physical plan.
- Cancellation closes every opened resource.
- The same logical query can be constructed through functional combinators and
  the fluent public API.
