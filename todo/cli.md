---
title: Implement the command-line interface
summary: Provide safe query, planning, application, explanation, schema, and plugin workflows over the library API.
depends_on: [textual-dsl]
spec_sections: [13, 15, 16, 17.2]
---

# Outcome

The CLI is a thin, scriptable process boundary whose outputs, exit codes, and
safety prompts are specified and tested independently from core semantics.

# Scope

- Resolve the product/package/executable name before making packages public.
- Add query, plan, apply, explain, schema, and plugin commands.
- Stream JSON Lines for automation and readable tables, trees, plans, and diffs
  for terminals without changing semantics.
- Define exit codes, cancellation, signal handling, diagnostics, color policy,
  redaction, configuration precedence, and non-interactive behavior.
- Require explicit application and additional acknowledgement for declared risk
  according to policy.

# Acceptance criteria

- CLI integration tests execute built artifacts through `node:test`.
- Piped query output is stable JSON Lines with diagnostics separated from data.
- Transformation commands preview by default and cannot apply accidentally.
- `explain` shows pushdown, buffering, mounts, and transaction boundaries.
- Secrets never appear in logs, diagnostics, plans, or rendered commands by
  default.
