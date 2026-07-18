---
title: Add typed DSL source and mount options
summary: Let textual programs configure adapter read and mount behavior without silent positional arguments or host-only closures.
depends_on: []
spec_sections: [7.2, 9.7, 11, 13, 17.1]
---

# Outcome

The textual DSL can express schema-checked source and mount options needed by
built-in and plugin adapters while compiling to ordinary query values.

# Finding

`from` accepts only scalar positional literals and each CLI resolver silently
coerces or ignores arguments. Mounts accept no arguments. Consequently the CLI
cannot request filesystem include/exclude pushdown, a non-default tree view, a
TypeScript project, or JSON mount error policy; extra arguments appear valid
but have no effect.

# Scope

- Design one declarative option shape for sources and mounts, including arrays
  where adapter contracts require them.
- Give resolver and mount contributions serializable argument schemas with
  arity, type, default, and unknown-field validation.
- Preserve deterministic formatting, source spans, laziness, and
  TypeScript/DSL parity without exposing arbitrary callbacks.
- Make physical explanations show resolved options and pushdowns without
  leaking sensitive values.

# Acceptance criteria

- Invalid, missing, and extra source or mount arguments produce source-ranged
  diagnostics rather than coercion or silent omission.
- A CLI test proves at least one filesystem pushdown and one mount policy are
  configurable and visible in `explain`.
- Plugin resolvers and mounts use the same contract as built-ins.
