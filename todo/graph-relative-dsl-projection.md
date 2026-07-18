---
title: Add graph-relative projection to the textual DSL
summary: Make repository inventory and similar structured extraction expressible without host callbacks.
depends_on: [cross-adapter-mounted-selectors]
spec_sections: [9.5, 9.7, 12, 18.1]
---

# Outcome

Textual queries can project related child or captured values with explicit
cardinality, missing-value, and ordering semantics.

# Finding

The repository inventory example uses `child("name").value` and
`child("dependencies")`, but the executable DSL expression grammar accepts
only literals and current/capture paths. The example is not parseable, and the
CLI cannot directly produce its promised package/dependency structure.

# Scope

- Start from repository inventory and cross-format extraction cases and choose
  one orthogonal graph-relative primitive or pipeline form.
- Specify zero/one/many cardinality, duplicate property names, missing versus
  null, ordering, provenance, and buffering behavior.
- Compile to the existing query algebra without arbitrary evaluation or
  adapter-specific object access.
- Update the example to the syntax actually implemented.

# Acceptance criteria

- The full repository inventory example executes through the CLI against
  mounted package manifests.
- Ambiguous scalar projections fail diagnostically or require an explicit
  collection policy.
- TypeScript and textual forms produce equivalent values and explain plans.
