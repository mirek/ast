---
title: Connect plugin predicates and scalar functions to query execution
summary: Make admitted query extensions callable through schema-checked selectors and DSL expressions, or narrow the public contract.
depends_on: []
spec_sections: [9.4, 9.7, 14, 16]
---

# Outcome

Plugin query contributions have a specified, executable, deterministic path
from manifest and alias to selector or DSL evaluation.

# Finding

Plugin registration validates and stores predicates, functions, and their
aliases, but `DslEnvironment` carries only sources, mounts, and operations and
the selector compiler has no plugin predicate environment. These admitted
contributions are unreachable after loading.

# Scope

- Define signatures, argument schemas, return types, missing/null behavior,
  purity requirements, diagnostics, and namespaced call syntax.
- Resolve aliases before compilation while preserving canonical names in plans
  and explanations.
- Decide whether predicate/function execution may be async and how it interacts
  with laziness, cancellation, pushdown, exceptions, and secret handling.
- Remove any contribution category that cannot be supported honestly.

# Acceptance criteria

- A CLI plugin fixture executes one selector predicate and one scalar function.
- Unknown, ill-typed, throwing, or unauthorized extensions produce stable
  source-located diagnostics.
- Plugin callbacks cannot be mistaken for adapter-native pushdown.
