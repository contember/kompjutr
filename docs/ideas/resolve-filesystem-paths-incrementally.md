# Resolve filesystem paths incrementally

## Idea

`plannedPaths` in `packages/do/src/fs/store/resolve.ts` builds every ancestor
prefix of a path by re-joining the whole component array:

```ts
function pathOf(parts: readonly string[]): string {
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}
```

One resolve of a `d`-component path therefore writes `O(d²)` characters before
it issues a single query, and `resolve()` calls `pathOf(resolved)` again per
component. Keeping a stack of already-built prefixes and appending one component
makes both `O(d)`.

## Evidence

WU6 of the [production correctness sprint](../archive/sprint-2026-09-10-production-correctness-and-memory.md)
removed the implicit 1,000-entry ceiling, so a path with 1,000 components now
reaches the filesystem through the public API. Aborting a merge that owns such a
path, measured on the DO SQLite filesystem under a two-vCPU lease:

| Components | apply | abort |
|---|---|---|
| 250 | 87 ms | 213 ms |
| 500 | 201 ms | 1,371 ms |
| 1,000 | 490 ms | 10,453 ms |

Abort grows about `n^2.9`, far above the `O(total path bytes)` the work needs.
A `--cpu-prof` run of the 1,000-component abort attributes 8,647 ms of 10,000 ms
of self time to `pathOf` at `resolve.ts:56`, reached from `plannedPaths`
(`resolve.ts:59`) and `resolve` (`resolve.ts:105`). Apply scales acceptably.

These are single local Node samples on one fixture. No Worker-isolate
measurement, no statement-count change, and no other filesystem operation was
profiled — `resolveMany` and every `stat`, `readFile` and `writeFiles` caller
shares the same planner, so the shape is probably not specific to abort.

## Open questions

- Does the incremental form keep the exact `.`/`..`/empty-component ordering the
  comment above `resolve()` protects? `..` must still pop before the next
  lookup, and a pop at the root must stay at `/`.
- Is `d` bounded anywhere else in practice, making this only a deep-path
  pathology rather than a general cost?
- `tests/fs/` conformance against `node:fs` is the witness; it needs a deep-path
  case that fails on the current planner for the change to be verifiable.

Not scheduled. This is outside the production correctness sprint, which is
explicit that unrelated traversal costs stay out of scope.
