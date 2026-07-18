---
title: Add configured-project TypeScript workflows to the CLI
summary: Allow CLI queries and transformations to use one explicitly configured TypeScript language service.
depends_on: [dsl-source-and-mount-options]
spec_sections: [7.2, 9.3, 10, 13, 17.1]
---

# Outcome

The CLI can opt into configured-project mode for compiler-proven symbol edges
and semantic rename while retaining syntax-only behavior when no project is
selected.

# Finding

The CLI always calls `createTypeScriptAdapter()` without a project. It advertises
and registers `ts::rename-symbol`, but every CLI rename fails because semantic
rename requires configured-project mode. Project symbol edges are likewise
unreachable.

# Scope

- Resolve a project path deterministically from explicit DSL/CLI configuration,
  with clear cwd and config-file-relative rules.
- Reuse one language service per configured project across direct and mounted
  TypeScript sources.
- Report out-of-project files and unsupported project references as specified.
- Keep syntax-only reads available without inventing symbols.

# Acceptance criteria

- A public CLI test traverses `ts::symbol` and previews then applies a
  project-wide semantic rename.
- The same query without project configuration exposes no symbol claims and
  returns the documented informational diagnostic.
- Explain and plugin/schema output state whether TypeScript is syntax-only or
  project configured without leaking source contents.
