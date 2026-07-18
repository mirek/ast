---
title: Expose change-plan failure policy in the CLI
summary: Let users select the core runtime's stop or continue-independent policy explicitly at apply time.
depends_on: []
spec_sections: [10.3, 13]
---

# Outcome

CLI apply exposes the same honest transaction-group scheduling policy as the
core API and reports skipped groups unambiguously.

# Finding

`applyChangePlan` supports `stop` and `continue-independent`, and the CLI now
enforces a command-specific option schema, but no apply option reaches the core
failure-policy execution context. Users cannot choose the documented
continuation behavior for independent groups.

# Scope

- Add a command-specific, explicit failure-policy option with a conservative
  default.
- Keep dependency-failed, policy-skipped, failed, and applied statuses distinct
  in both pretty and JSON Lines reports.
- Document how risk acknowledgements and cancellation interact with groups
  that have not started.

# Acceptance criteria

- CLI tests use multiple independent and dependent groups to distinguish both
  policies.
- Continuing never schedules a group whose dependency failed.
- Reports state whether effects occurred before failure and retain exit 5 when
  any group fails.
