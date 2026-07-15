---
name: evolve-ast-spec
description: Design, review, or revise ast architecture, public semantics, adapter contracts, selector or DSL behavior, safety rules, and implementation sequencing. Use when changing SPEC.md, decomposing or revising files under todo/, resolving open design questions, or aligning repository skills and documentation with a design decision.
---

# Evolve the ast specification

1. Start from concrete cross-resource queries, transformations, failure cases,
   and scale constraints rather than syntax alone.
2. Test each proposal against lazy execution, explicit tree views, named graph
   edges, provenance, adapter-owned semantics, pure planning, revision checks,
   and TypeScript/DSL parity.
3. Prefer one orthogonal primitive over overlapping special cases, but do not
   erase domain-specific behavior to achieve superficial uniformity.
4. Specify types, semantics, diagnostics, ordering, identity, lifecycle,
   security, and failure behavior together.
5. Use prototypes to answer open questions whose limiting factor is adapter or
   change-protocol behavior.
6. Update `SPEC.md`, affected TODO files, `TODO.md`, `README.md`, `AGENTS.md`, and
   repository skills together whenever the resulting state makes them stale.
7. Delete completed TODO files and their index entries. Never mark completed
   work as done or keep it in the active backlog.

Keep the TypeScript query algebra as the semantic foundation. Treat the textual
DSL as a representation of the same logical plan, not a second runtime.
