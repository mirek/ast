---
title: Stabilize adapter and operation contracts
summary: Replace illustrative interfaces with evidence-based extension contracts after the required adapters exist.
depends_on: [markdown-adapter, typescript-adapter]
spec_sections: [7, 8, 10, 19, 20]
---

# Outcome

The adapter surface is small, composable, versionable, and honest about domain
differences demonstrated by filesystem, JSON, Markdown, and TypeScript.

# Scope

- Compare adapter needs for discovery, hydration, mounts, native compilation,
  execution, planning, apply, transactions, and cleanup.
- Resolve eager attributes, identity across reparses, mount semantics, generic
  structural operations, compensation, and capability negotiation.
- Split optional behavior into focused interfaces rather than a monolith.
- Add an adapter conformance suite and compatibility rules.
- Update all examples, skills, and dependent TODOs to the stabilized vocabulary.

# Acceptance criteria

- Required adapters implement the contracts without unsafe casts or empty stubs.
- Unsupported capabilities fail at validation or planning, not deep in execution.
- Conformance tests verify lifecycle, laziness, provenance, revision, and safety
  invariants.
- The spec clearly distinguishes stable contracts from provisional extensions.
