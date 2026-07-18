---
title: Expose Markdown tree views in textual queries
summary: Let DSL and CLI queries select the syntax tree or section tree explicitly and consistently.
depends_on: [dsl-source-and-mount-options]
spec_sections: [6.3, 7.2, 9.2, 13, 17.1]
---

# Outcome

Markdown section queries are available through the public textual boundary and
use exactly the child edges declared by `markdown::section-tree`.

# Finding

The core adapter and TypeScript selector API support explicit tree views, but
the CLI always opens Markdown with its default syntax tree. Selecting
`markdown::section` from README produces no rows, and an extra source argument
purporting to choose the section tree is silently ignored.

# Scope

- Carry the selected tree view through DSL source/mount options, source
  descriptors, selector validation, execution, and explain output.
- Define capture and subsequent-selector behavior when a pipeline changes or
  retains a tree view.
- Reject unknown and adapter-incompatible tree views with source locations.

# Acceptance criteria

- CLI tests query the same document through both Markdown views and demonstrate
  their different containment relationships.
- Section selection remains source ordered and duplicate headings stay
  distinct.
- TypeScript API and DSL explanations agree on the selected view.
