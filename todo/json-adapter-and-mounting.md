---
title: Implement JSON adaptation and nested mounts
summary: Expose JSON structure as nodes and prove transparent traversal between filesystem and document adapters.
depends_on: []
spec_sections: [7.2, 17.1, 17.2, 18.1]
---

# Outcome

A filesystem file can mount a JSON resource, participate in one query, and
produce faithful updates for ordinary JSON documents.

# Scope

- Model roots, objects, properties, arrays, indices, and scalar values.
- Preserve deterministic object/array traversal and distinguish missing from
  explicit null.
- Define mount identity, ownership, lifecycle, provenance, and the path back to
  the containing `fs::file` node exposed by `createFilesystemAdapter`.
- Reuse lazy `fromFilesystem` discovery without reading file bytes until a JSON
  mount is actually opened.
- Support value replacement, property insertion/removal, and array edits through
  adapter operations.
- Preserve encoding and final-newline behavior; document formatting limits.

# Acceptance criteria

- One query traverses filesystem and JSON nodes without eager file parsing.
- Mounted roots have unsurprising child and descendant semantics backed by tests.
- Unchanged documents round-trip byte-for-byte when supported.
- Edits affect only the smallest practical source region or explicitly explain
  when reserialization is required.
- Invalid JSON produces source-located diagnostics while unrelated files remain
  queryable under the chosen error policy.
