---
title: Implement change plans and explicit local apply
summary: Convert operations into inspectable changes with diffs, conflicts, dependencies, revisions, risk, and controlled effects.
depends_on: [json-adapter-and-mounting]
spec_sections: [6.7, 10, 13, 16, 17.2]
---

# Outcome

Cross-file operations yield serializable, reviewable plans, and local effects
occur only through an explicit apply boundary.

# Scope

- Define operations, changes, preconditions, risks, transaction groups, and
  adapter-private serializable payloads.
- Detect overlapping or contradictory source changes and order dependencies.
- Render textual diffs and summaries without exposing secrets.
- Revalidate revisions immediately before apply and stop dependent changes after
  a failure.
- Model partial-application, rollback, and compensation honestly.

# Acceptance criteria

- Planning has no externally visible mutation.
- A source changed after planning causes apply to fail without overwriting it.
- Independent and dependent failures follow explicit, tested scheduling policy.
- Saved plans reject incompatible adapter/schema versions and resource identity.
- Destructive and irreversible work is machine-readable and visually distinct.
