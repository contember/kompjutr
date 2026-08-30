---
id: 0014
title: Make an optionless clone complete
status: accepted
date: 2026-08-28
---

# 0014 — Make an optionless clone complete

## Context

Clone previously defaulted to depth one, the remote HEAD branch, and no tags.
The option types did not expose those defaults, so an ordinary call produced a
repository that looked usable but could not answer history questions beyond its
first commit. `mergeBase()` and `divergence()` then reported a shallow boundary,
and the current fetch API cannot deepen an existing clone.

A shallow default reduces the first request's transfer, CPU, and stored bytes.
It also makes basic history operations unreliable unless every caller knows to
override three independent options. Real Git accepts the larger initial cost and
creates a complete clone by default.

## Decision

An optionless clone will fetch complete history, every advertised branch, and
the tag references that a normal Git clone fetches. It will not create a shallow
boundary. `singleBranch: true` will remain an explicit branch-coverage limit and
will follow tags reachable from that branch. `noTags: true` will remain an
explicit tag-coverage limit. A positive `depth` will remain the explicit way to
request shallow history and will imply `singleBranch: true` unless the caller
explicitly sets it to `false`; zero continues to mean no depth limit. A
depth-limited single-branch clone follows only tags reachable from that branch.
Explicit all-branch coverage retains Git's normal complete tag coverage.

The transfer and pack ingest remain bounded and streaming. Changing the default
does not change the structural bounds of ingest (ADR-0017).

## Consequences

An ordinary clone can immediately compare branches with `mergeBase()` and
`divergence()`, and its remote branches and tags match a real Git clone. Callers
that need a cheaper first request must now state that policy with `depth`,
`singleBranch`, or `noTags`.

`noTags: false` matches Git's `--tags`: it restores normal tag following but
does not widen an effective single-branch clone to unrelated tag targets.

The default may transfer, validate, and store substantially more history. It can
therefore consume more network, CPU time, storage, and billable Worker duration
even though peak retained memory remains bounded. Repositories that exceed an
existing structural limit fail closed instead of silently becoming partial.

## Alternatives considered

- Keep the shallow default and document it. This preserves the hidden failure
  mode and cannot help callers that discover the boundary after cloning.
- Choose a shallow default dynamically from repository size. The client cannot
  know the complete graph cost before negotiation, and identical calls could
  then produce repositories with different capabilities.
- Require every caller to choose a depth. This makes the cost visible but breaks
  the familiar optionless Git operation without improving its safety.
