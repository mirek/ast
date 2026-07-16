---
title: Validate the architecture end to end
summary: Demonstrate the specification's acceptance criteria and operational qualities before declaring the first architecture stable.
depends_on: [sql-adapter-prototype]
spec_sections: [3, 15, 16, 17, 19]
---

# Outcome

Executable scenarios show that the common model composes real resources without
sacrificing semantics, bounded memory, safety, diagnostics, or explainability.

# Scope

- Query a directory while mounting at least two file-format adapters.
- Exercise one selector engine across filesystem, document, and code nodes.
- Traverse reference edges separately from containment.
- Produce and apply a cross-format plan under revision checks.
- Measure streaming, buffering, pushdown, cancellation, adapter latency, and
  resource cleanup on repository-scale fixtures.
- Audit documentation, skills, schemas, examples, and package metadata against
  the delivered behavior.

# Acceptance criteria

- Every criterion in `SPEC.md` section 19 has an executable conformance test or
  an explicit spec revision explaining why it changed.
- Large-directory scenarios demonstrate bounded memory and early termination.
- Cross-format plans are inspectable, deterministic, and rejected after source
  drift.
- Diagnostics identify both program expressions and originating source nodes.
- No completed TODO remains in `todo/` or `TODO.md` after this work is merged.
