# Working on ast

Treat [SPEC.md](./SPEC.md) as the source of truth for observable behavior and
[TODO.md](./TODO.md) as the index of remaining implementation work. Read the
relevant task in `todo/` before changing behavior.

All Markdown documentation and repository skills are live documents. Every
pull request must review the affected documents and skills and update them in
the same pull request so they describe the resulting state. Never knowingly
leave stale plans, examples, package boundaries, commands, or instructions.

TODOs represent only work that remains. When a task is complete, delete its
file from `todo/` and remove its entry from `TODO.md`; never mark it completed
or retain it as historical documentation. Update dependent tasks when the
completed work changes their assumptions.

Keep `@mirek/ast` deterministic and independent of CLI concerns. Keep argument
parsing, process exit codes, terminal rendering, and direct user interaction in
`@mirek/ast-cli`. Preserve adapter-owned domain semantics instead of forcing
mutations through generic graph operations.

For each behavior change, begin with an executable `node:test` case through a
public boundary. Prefer immutable values, small composable functions, Node.js
built-ins, and lazy `AsyncIterable` execution.

Run `pnpm check` and `pnpm build` before finishing a change. Use the repository
skills in `.agents/skills` when their descriptions match the task.
