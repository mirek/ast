---
title: Recognize malformed saved plans without DSL fallback
summary: Treat plan-shaped JSON and explicit plan inputs as plans even when required envelope fields are missing.
depends_on: [cli-input-modes-and-locations]
spec_sections: [6.7, 10.3, 13]
---

# Outcome

Every intended saved-plan input is either validated as a complete compatible
envelope or rejected with exit 3; it is never reinterpreted as DSL.

# Finding

Apply recognizes a saved plan only when parsed JSON already contains both a
string `integrity` and `plan`. For example, `{"plan":{"formatVersion":"1"}}`
falls through to DSL compilation and exits 2 with `dsl.expected-source` instead
of the documented invalid-plan result.

# Scope

- Use explicit input mode and conservative plan-shaped JSON detection.
- Keep integrity, format, adapter, schema, plugin, identity, and revision
  validation in the saved-plan loader.
- Ensure malformed or incompatible envelopes cannot reach DSL fallback or an
  effect boundary.

# Acceptance criteria

- Public CLI tests remove or mistype each required envelope field and always
  receive `cli.invalid-plan`, exit 3, and no effects.
- Non-plan JSON supplied explicitly as inline DSL retains a clear DSL error.
- Valid transformation DSL remains applicable only through the documented DSL
  input mode and confirmation policy.
