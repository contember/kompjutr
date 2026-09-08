# sprints

Active thematic work-plans being executed **now**. One file per sprint:
`sprint-YYYY-MM-DD-<theme>.md` (copy [`_template.md`](_template.md)). Multiple may
be active at once.

A sprint is the unit of work. Running it unattended ("do everything autonomously")
is just a sprint with no human watching — same file, same rules.

Lifecycle (full detail in [`../CLAUDE.md`](../CLAUDE.md)):

1. **Create** — copy the template; re-verify load-bearing facts at HEAD, declare
   a concrete review gate for the sprint integration and every WU, then get an
   independent review of the full proposal and those gates before implementation.
2. **Run** — work the WUs; append discoveries/blockers to `## Run log`; graduate
   entries to a `../decisions/` ADR or a `../backlog/` item.
3. **Close** — stamp the `OUTCOME` header, `git mv` to `../archive/`, delete/rescope
   consumed backlog items, refresh affected `../reference/`, update
   [`../INDEX.md`](../INDEX.md).

## Active

- [`sprint-2026-09-08-lifecycle-and-network-integrity.md`](sprint-2026-09-08-lifecycle-and-network-integrity.md)
  — backlog 71, 72, 73. Statically verified only; each unit reproduces before it
  fixes. Plan review pending.
