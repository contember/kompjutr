---
id: 105
title: Measure eager status result memory and decide its boundary
blocked-by: []
---

# 105 — Measure eager status result memory and decide its boundary

**Summary.** `status()` and `eagerStatus()` materialize their entire returned
row array. The 30,000-path cap bounds the internal tracked-path snapshot in
normal mode, but does not bound the result in `untrackedFiles: "all"` or `"no"`.

An existing sparse-status test requires 32,001 valid results and reseals the
same paths. Do not impose the snapshot's 30,000-path cap on public results: a
trial of that change rejected this valid case. Measure representative peaks
under `bench/CLAUDE.md` rules, including many short rows and near-8-KiB paths.
Then decide whether eager result materialization needs a separate API or count
boundary, with explicit acceptance for the existing 32,001-row case and a
failure witness if a new limit is approved. Preserve the lazy `statusStream()`
contract and the optional sparse reseal behavior.
