# Reduce prefix rebuilding in filesystem component walks

## Idea

At `f8a677a` (2026-10-13), canonical paths that follow no symlink already take
a fast path: `candidatesOf()` and `resolveWalk()` use `prefixesOf()` from
`packages/do/src/fs/path.ts`, which slices the original path. `resolveWalk()`
then returns that path without rebuilding it. Commit `75acf9d` introduced
this optimization on 2026-09-28.

The remaining candidate is the component walk for noncanonical paths and
symlink expansion. `plannedPaths()` in
`packages/do/src/fs/store/resolve.ts` still rebuilds prefixes by joining the
whole component array:

```ts
function pathOf(parts: readonly string[]): string {
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}
```

For bounded-size components, this fallback builds `O(d²)` prefix characters
for a `d`-component path, and `resolveComponents()` repeats the joins while
walking. A stack of previously built prefixes could avoid repeated array
joins. It would not make the entire resolver linear: sizing and serializing
all prefixes still processes their aggregate bytes.

## Historical evidence

The following measurements predate the canonical fast path. They do not
establish the current cost of merge abort or of the remaining fallback.

WU6 of the [production correctness sprint](../archive/sprint-2026-09-10-production-correctness-and-memory.md)
removed the implicit 1,000-entry ceiling, so a path with 1,000 components now
reaches the filesystem through the public API. Aborting a merge that owns such a
path, measured on the DO SQLite filesystem under a two-vCPU lease:

| Components | apply | abort |
|---|---|---|
| 250 | 87 ms | 213 ms |
| 500 | 201 ms | 1,371 ms |
| 1,000 | 490 ms | 10,453 ms |

In those samples, abort grew about `n^2.9`.
A `--cpu-prof` run of the 1,000-component abort attributed 8,647 ms of 10,000 ms
of self time to `pathOf` at `resolve.ts:56`, reached from `plannedPaths`
(`resolve.ts:59`) and `resolve` (`resolve.ts:105`), at the then-current source
locations.

These are single local Node samples on one fixture. No Worker-isolate
measurement, no statement-count change, and no other filesystem operation was
profiled. No new performance measurement was made in the 2026-10-13 review.

## Open questions

- Does the remaining fallback cause a measurable cost in a real workflow?
  Compare canonical, dot-segment, and symlink paths under the rules in
  `bench/CLAUDE.md` before choosing an optimization.
- Does an incremental form preserve component order, missing-parent errors,
  symlink expansion, and confinement? `..` must not bypass a file or escape
  a confined root.
- Is `d` bounded anywhere else in practice, making this only a deep-path
  pathology rather than a general cost?
- `tests/fs/resolve.test.ts` covers canonical/component-walk parity, symlink
  ordering, and batched query shape. Extend it and filesystem conformance
  with the specific fallback case established by measurement.

Graduates when current measurement establishes a material fallback cost and a
behavioral witness protects the affected path semantics.
