# Measure eager status result memory and decide its boundary

**Summary.** `status()` and `eagerStatus()` materialize their entire returned
row array. The 30,000-path cap bounds the internal tracked-path snapshot in
normal mode, but is not a public result limit. In `untrackedFiles: "all"` or
`"no"`, the prepass can omit that snapshot when no exclusion roots require it.

Checked at `f8a677a` (2026-10-13):

- `packages/git/src/ops/status/status-core.ts` collects the stream into an
  array in `status()` and both result paths of `eagerStatus()`.
- `tests/status-sparse.test.ts`, "returns normal status and reseals after the
  former dirty-row cap", still accepts 32,001 results and reseals all 32,001
  paths. It passed during the review.
- The lazy `statusStream()` contract remains available. The review did not
  measure eager-result memory or establish a new memory failure.

Do not impose the snapshot's 30,000-path cap on public results: a trial of
that change rejected the valid 32,001-row case. Measure representative peaks
under `bench/CLAUDE.md` rules, including many short rows and near-8-KiB paths.
Then decide whether eager result materialization needs a separate API or count
boundary, with explicit acceptance for the existing 32,001-row case and a
failure witness if a new limit is approved. Preserve the lazy `statusStream()`
contract and the optional sparse reseal behavior.

Graduates to the backlog when a measurement or a consumer shows a real failure
from an eager result; the lazy `statusStream()` already serves large results.
