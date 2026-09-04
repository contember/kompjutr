---
id: 0014
title: Make an optionless clone complete
status: accepted
date: 2026-08-28
---

# 0014 — Make an optionless clone complete

## Context

Clone originally defaulted to depth one, the remote HEAD branch, and no tags.
The option types did not expose those defaults, so an ordinary call produced a
repository that looked usable but could not answer history questions beyond its
first commit — `mergeBase()` and `divergence()` reported a shallow boundary.

A shallow default reduces the first request's transfer, CPU, and stored bytes.
It also makes basic history operations unreliable unless every caller knows to
override three independent options. Real Git accepts the larger initial cost and
creates a complete clone by default.

When this was decided, the fetch API could not deepen an existing clone, so a
shallow default was effectively permanent. Relative deepening and `--unshallow`
have shipped since, which makes the mistake recoverable — but not visible. A
caller still discovers the boundary only when a history question returns the
wrong answer, so the decision stands on the remaining reason: an optionless call
must not silently produce a repository that cannot answer ordinary questions.

## Decision

An optionless clone fetches complete history, every advertised branch, and the
tag references a normal Git clone fetches. It creates no shallow boundary.

`singleBranch: true` remains an explicit branch-coverage limit and follows tags
reachable from that branch. `noTags: true` remains an explicit tag-coverage
limit. A positive `depth` remains the explicit way to request shallow history and
implies `singleBranch: true` unless the caller sets it to `false`; zero continues
to mean no depth limit. A depth-limited single-branch clone follows only tags
reachable from that branch, while explicit all-branch coverage retains Git's
normal complete tag coverage.

Transfer and pack ingest remain bounded and streaming. Changing the default does
not change the structural bounds of ingest
([ADR-0005](0005-bound-real-failures-and-measure-cost.md)).

## Consequences

- An ordinary clone can immediately compare branches with `mergeBase()` and
  `divergence()`, and its remote branches and tags match a real Git clone.
- Callers that need a cheaper first request must state that policy with `depth`,
  `singleBranch`, or `noTags`.
- `noTags: false` matches Git's `--tags`: it restores normal tag following but
  does not widen an effective single-branch clone to unrelated tag targets.
- The default may transfer, validate, and store substantially more history, so it
  can consume more network, CPU, storage, and billable Worker duration even
  though peak retained memory stays bounded.
- A repository that exceeds an existing structural limit fails closed instead of
  silently becoming partial.

## Alternatives considered

- **Keep the shallow default and document it.** Preserves the hidden failure mode
  and cannot help a caller who discovers the boundary after cloning.
- **Choose a shallow default dynamically from repository size.** The client
  cannot know the complete graph cost before negotiation, and identical calls
  would then produce repositories with different capabilities.
- **Require every caller to choose a depth.** Makes the cost visible but breaks
  the familiar optionless Git operation without improving its safety.
