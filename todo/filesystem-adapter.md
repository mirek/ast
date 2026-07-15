---
title: Implement the filesystem adapter
summary: Stream local directory graphs with metadata pushdown, revisions, provenance, and safe operation planning.
depends_on: [selector-engine]
spec_sections: [7, 17.1, 17.2]
---

# Outcome

Repository-sized directory trees can be queried lazily without loading the full
tree, and filesystem changes are represented as intent rather than immediate
effects.

# Scope

- Model directories, files, and symlinks with stable ordering and documented
  identity guarantees.
- Push safe path, glob, kind, and metadata predicates into traversal.
- Define revision observations appropriate for optimistic local-file checks.
- Expose plan-only write, move, remove, and create operations.
- Handle symlink loops, permission failures, disappearing paths, cancellation,
  ignored paths, binary values, and large files explicitly.

# Acceptance criteria

- Large synthetic trees stream with bounded memory and observable early stop.
- `explain` distinguishes pushed-down and runtime predicates.
- Symlinks are reference edges and cannot cause implicit recursive cycles.
- Planning a write, move, or remove performs no mutation.
- Diagnostics retain filesystem provenance without leaking file contents.
