---
title: Make CLI input modes and diagnostic locations explicit
summary: Distinguish files, inline programs, saved plans, and stdin instead of guessing from filesystem existence.
depends_on: []
spec_sections: [9.7, 13, 15]
---

# Outcome

Users and automation select an unambiguous input mode, missing files fail as
missing files, stdin works, and every diagnostic carries a truthful URI.

# Finding

The CLI treats an argument as a file only when that path currently exists and
otherwise parses the path text as inline DSL. `ast query -` parses the single
character `-` instead of reading stdin. Inline diagnostics currently use
`resolve(cwd, completeProgramText)`, producing a fabricated filesystem path.

# Scope

- Define explicit file, inline-expression, and stdin forms for query, plan,
  apply, and explain inputs.
- Keep a compatibility path only if it is deterministic and cannot disguise a
  missing file or malformed saved plan.
- Assign stable non-file URIs to argv and stdin programs and retain real paths
  for files.
- Propagate cancellation while reading stdin and reject ambiguous combinations.

# Acceptance criteria

- Public CLI tests cover stdin, inline DSL, file DSL, missing files, and
  truthful program locations.
- A typo in a DSL or plan filename never becomes a parse attempt of the
  filename itself.
- Piped input preserves JSON Lines stdout/stderr separation and documented exit
  statuses.
