# Implementation TODOs

This index contains only work that remains. Complete tasks in dependency order
unless a prototype is explicitly intended to answer an earlier design question.
When a task is complete, delete both its file and this index entry rather than
marking it completed.

- [Make CLI input modes and diagnostic locations explicit](./todo/cli-input-modes-and-locations.md) — distinguish files, inline programs, saved plans, and stdin without existence guessing.
- [Harden CLI argument and configuration validation](./todo/cli-argument-and-config-validation.md) — enforce command shapes, config schemas, help behavior, and usage exit codes.
- [Connect plugin presentation extensions and report complete inventory](./todo/plugin-presentation-and-inventory.md) — make admitted renderers, diffs, and non-adapter plugins visible and usable safely.
- [Recognize malformed saved plans without DSL fallback](./todo/strict-saved-plan-recognition.md) — reject incomplete envelopes as invalid plans rather than parsing them as DSL.
- [Support selectors across mounted adapter boundaries](./todo/cross-adapter-mounted-selectors.md) — validate and execute selectors that cross container-to-mount edges.
- [Expose the complete filesystem transformation surface in the CLI](./todo/filesystem-cli-transformations.md) — add move, remove, create, and encoded writes.
- [Expose Markdown tree views in textual queries](./todo/markdown-tree-view-dsl.md) — make syntax and section containment selectable through DSL and CLI.
- [Add configured-project TypeScript workflows to the CLI](./todo/typescript-project-cli.md) — expose symbol edges and semantic rename with an explicit project.
- [Connect plugin predicates and scalar functions to query execution](./todo/plugin-query-extensions.md) — give admitted query extensions a real selector and DSL execution path.
- [Expose change-plan failure policy in the CLI](./todo/cli-apply-failure-policy.md) — allow explicit stop or continue-independent apply scheduling.
- [Add graph-relative projection to the textual DSL](./todo/graph-relative-dsl-projection.md) — make the documented repository inventory extraction executable.
