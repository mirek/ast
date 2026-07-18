---
title: Fix filesystem selector source semantics
summary: Prevent the CLI filesystem source from turning one tree node into repeated selector results through redundant traversal.
depends_on: []
spec_sections: [6.5, 9.6, 9.7, 13, 17.1]
---

# Outcome

`from fs(...) | select ...` gives every filesystem node one intentional source
path unless the query itself introduces additional graph paths. Bag semantics
remain intact and the CLI does not hide the problem with an implicit
`distinct`.

# Finding

The built-in `fs` source uses `fromFilesystem`, which already yields a recursive
walk. `selectFrom` then recursively traverses from every yielded node. Against
`packages/cli/src`, selecting the two TypeScript files emitted four rows; an
explicit `distinct` reduced the result to two.

# Scope

- Define whether a DSL source yields resource roots or a preselected stream and
  make selector compilation respect that distinction.
- Preserve filesystem filter pushdown, stable path ordering, laziness,
  cancellation, cleanup, and explicit bag semantics.
- Check mounted filesystem pipelines so the fix neither repeats mounts nor
  removes duplicates created by genuinely distinct graph paths.

# Acceptance criteria

- A public CLI test selects nested files without repeated rows.
- Equivalent TypeScript and DSL queries have the same cardinality and explain
  plan.
- A separate multi-path graph test still demonstrates bag semantics, and
  `distinct` remains explicit.
