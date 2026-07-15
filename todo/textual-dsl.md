---
title: Design and implement the textual DSL
summary: Add concise pipeline syntax only after the TypeScript algebra and adapter contracts are proven.
depends_on: [stabilize-adapter-contracts]
spec_sections: [9.7, 10, 11, 12, 20]
---

# Outcome

Textual programs parse, validate, and compile into the same logical query and
operation values as the TypeScript API.

# Scope

- Decide the minimum expression, binding, capture, source, pipeline, projection,
  join, invocation, and plan syntax from executable use cases.
- Preserve complete source spans and schema-aware diagnostics.
- Specify escaping, literals, regular expressions, null/missing values, imports
  or their deliberate absence, and deterministic formatting.
- Keep arbitrary code outside the declarative core behind explicit boundaries.
- Add equivalence tests between textual and programmatic construction.

# Acceptance criteria

- The DSL receives no privileged runtime path.
- Repository inventory and cross-format transformation examples are executable.
- Parse, schema, type, capability, and planning errors point to useful spans.
- The grammar excludes unproven general recursion and module machinery.
- Syntax decisions and edge cases are reflected in `SPEC.md` in the same change.
