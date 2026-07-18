---
title: Connect plugin presentation extensions and report complete inventory
summary: Use admitted renderers and diff providers intentionally and make non-adapter plugins visible to users.
depends_on: []
spec_sections: [13, 14, 15, 16]
---

# Outcome

`ast plugins` reports loaded packages and every contribution category, and
explicitly selected plugin renderers or diff providers participate in safe CLI
presentation.

# Finding

The registry validates renderers, diff providers, aliases, and plugin
manifests, but the CLI never consumes those presentation contributions.
`ast plugins` iterates adapters rather than plugin manifests, so a valid plugin
without an adapter is invisible and contribution availability cannot be
inspected.

# Scope

- Define explicit renderer/diff selection and fallback rules for terminal and
  automation formats.
- Preserve JSON Lines stability, redaction, sensitive-preview defaults, and the
  rule that presentation never changes plan semantics.
- Report package identity, trust/isolation status, powers, namespaces, aliases,
  and contribution names, including packages with no adapter.
- Treat plugin callback failures as diagnostics with no unsafe fallback that
  reveals content.

# Acceptance criteria

- A plugin-only renderer/diff fixture is visible in `ast plugins` and can be
  selected explicitly.
- Non-terminal JSON Lines output remains canonical and independent of terminal
  renderers.
- Presentation extensions cannot reveal redacted plan content by default.
