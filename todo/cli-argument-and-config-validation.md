---
title: Harden CLI argument and configuration validation
summary: Reject invalid command shapes and configuration with usage diagnostics and the documented exit status.
depends_on: []
spec_sections: [13]
---

# Outcome

The CLI has command-specific arguments, validated configuration, useful help,
and a stable distinction between usage failures and execution diagnostics.

# Finding

Unknown options, invalid flag values, and explicit missing config files exit 2
although configuration and usage are specified as exit 1. Extra positionals
and irrelevant flags such as `query --save` are silently ignored. Invalid
`.astrc.json` values such as `format: "yaml"` and `color: "rainbow"` are
accepted. `--help` exits 1, and `schema` without a namespace becomes a generic
execution diagnostic.

# Scope

- Define and validate the positional arguments and legal flags per command.
- Validate the complete config shape, plugin entries, and enum values without
  retaining caller-owned mutable data.
- Provide successful global and command help and decide a version surface.
- Emit stable usage/config diagnostic codes and exit 1; reserve exit 2 for
  compilation or execution failures.

# Acceptance criteria

- Table-driven CLI tests cover every command, option, config source, precedence
  rule, extra positional, and missing value.
- Invalid configuration cannot silently change renderer behavior.
- Help is useful in both terminal and non-terminal contexts and exits 0.
