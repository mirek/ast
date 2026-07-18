---
title: Support selectors across mounted adapter boundaries
summary: Validate and execute one selector sequence that crosses a container node and a mounted resource.
depends_on: [dsl-source-and-mount-options]
spec_sections: [7.2, 8, 9.2, 9.3, 11, 18.1]
---

# Outcome

Mounted resources behave as one typed graph for selection while each adapter
continues to own its kinds, edges, tree views, and resource lifecycle.

# Finding

After `mount json`, selector compilation validates only against the JSON schema.
The concrete selector `fs::file > json::root` is rejected as an unknown
`fs::file`, even though the mount is represented by a child edge and the spec
uses cross-resource selector examples.

# Scope

- Define composite schema resolution for every step as traversal crosses an
  adapter-owned mount edge.
- Preserve fully namespaced validation, per-adapter tree views, provenance,
  lazy mount opening, cancellation, and early-close behavior.
- Keep reference edges explicit and avoid treating arbitrary resources as one
  lowest-common-denominator schema.
- Make logical and physical explanations identify adapter transitions.

# Acceptance criteria

- Public selector and CLI tests execute filesystem-to-JSON,
  filesystem-to-Markdown, and filesystem-to-TypeScript sequences.
- Unknown cross-adapter kinds, edges, and attributes retain precise selector
  spans and name the responsible schema.
- Merely compiling or filtering the containing filesystem nodes does not open
  mounted resources.
