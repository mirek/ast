---
title: Expose the complete filesystem transformation surface in the CLI
summary: Make filesystem move, remove, create, and encoded write operations available with their adapter-owned safety semantics.
depends_on: []
spec_sections: [7.3, 10, 13, 17.1, 17.2]
---

# Outcome

Textual programs can plan every filesystem operation implemented by the core
adapter without bypassing preview, revision checks, or risk acknowledgement.

# Finding

The filesystem adapter implements and documents `write`, `move`, `remove`, and
`create`, but the CLI environment registers only `fs::write`, fixed to UTF-8.
`invoke fs::move`, `fs::remove`, and `fs::create` fail as unsupported, and
binary writes are unreachable.

# Scope

- Register all filesystem operations with schema-derived argument validation.
- Represent destination paths, create kinds, UTF-8/base64 encoding, and content
  without lossy string/number coercion.
- Preserve adapter-owned revisions, destination-absence checks, risk labels,
  previews, conflict detection, and explicit apply.

# Acceptance criteria

- CLI integration tests preview and apply each operation in a temporary root.
- Missing or invalid arguments fail before planning with DSL locations.
- Duplicate selector targets cannot produce accidental repeated or conflicting
  filesystem changes.
