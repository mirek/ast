---
title: Implement plugin loading, manifests, and policy
summary: Make adapter extensions discoverable and versioned while stating the JavaScript trust boundary precisely.
depends_on: []
spec_sections: [14, 16]
---

# Outcome

JavaScript and TypeScript packages can contribute namespaced adapters and
extensions through explicit manifests, version checks, and user policy.

# Scope

- Define manifests for adapters, schemas, resolvers, mounts, predicates,
  functions, renderers, diff providers, optimizer rules, and required powers.
- Enforce globally unique namespaces and configurable aliases.
- Record plugin and schema versions in plans and reject unsafe replay.
- Add allowlisting and separate filesystem, network, process, credential, native
  module, read, and write capabilities.
- State clearly that unrestricted JavaScript plugins are trusted code until a
  real isolation mechanism exists.

# Acceptance criteria

- Unknown, duplicate, incompatible, or unauthorized plugins fail before use.
- Optimizer extensions can declare only semantics-preserving equivalences.
- Dynamic schemas retain runtime validation and useful diagnostics.
- Plans cannot silently load a different plugin implementation at apply time.
- Security documentation matches actual enforcement rather than aspirational
  sandboxing.
