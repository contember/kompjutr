---
id: 101
title: Use tracked prefixes in status pruning
blocked-by: []
---

# 101 — Use tracked prefixes in status pruning

**Summary.** Resolve ARCH-29's repeated scan of all tracked paths for each
ignored or excluded directory.

`packages/git/src/ops/status/status-full.ts` already retains tracked directory
prefixes. Use an exact tracked-path or prefix lookup when deciding whether to
prune, including paths observed during the merge stream. Preserve ignored and
nested-repository behavior. Witness with the ignored/tracked pruning and scale
cases in `tests/status.test.ts`; do not introduce a scalar SQL read per path.
