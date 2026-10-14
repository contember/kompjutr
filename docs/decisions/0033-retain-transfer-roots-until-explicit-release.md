---
id: 0033
title: Retain transfer roots until explicit release
status: accepted
date: 2026-10-14
---

# 0033 — Retain transfer roots until explicit release

## Context

A Smart HTTP response can outlive the refs that selected its objects. Maintenance
may run while a client stops reading, and a Durable Object may restart before a
response finishes. A JavaScript collection of object IDs neither retains objects
for GC nor survives a restart. A full-clone graph also exceeds the client push
planner's bounded in-memory object list.

## Decision

Each transfer has a repository-scoped owner with a monotonic integer identity,
an expiry, and a released flag in `git_transfers`. `git_transfer_roots` records
its roots. `git_transfer_objects` holds the paged frontier, visited objects and
final plan, separately for common and wanted closure. Compute common closure
first, then wanted closure excluding common objects. Required edges retain and
check their object types; gitlinks belong to another repository and are excluded.
Transfers require complete repositories: no shallow boundary or unresolved blob
promise is allowed.

Register roots before yielding. Maintenance retains every unreleased owner's
roots, including an expired owner's roots until cleanup explicitly releases it.
Registration, release and expiry cleanup advance the maintenance root epoch.
Renewal does not change the root set and does not advance the epoch. An expired
owner cannot renew or resume an object read. This prevents a clock change alone
from invalidating an already captured maintenance root set.

Response readers check ownership after awaits. The plan records logical OIDs,
not physical pack offsets. Normal object reads use a fixed batch; an oversized
object uses the existing object-size bound. No physical storage iterator survives
an await, so repacking can replace a source without invalidating the response.
Cancellation releases the owner even before the response iterator's first pull.

Release marks an owner; it does not synchronously cascade through its whole
plan. Cleanup deletes fixed pages of child rows, then removes the empty owner.
Repository destruction may cascade all owned rows. `maintainRepository()` advances
cleanup along with GC, reports `phase: "transfers"` while cleanup remains, and
includes the next active-owner expiry in its completion deadline. A hosting DO
can use that deadline for an alarm after a cold restart.

## Consequences

Memory remains bounded independently of history length, at the cost of durable
scratch rows and additional SQL. A slow client can hold roots until its lease
expires; resuming afterward fails. An abandoned transfer is reclaimed by normal
maintenance without requiring the old process or a public scratch ref.

The same semantic walker validates incoming pack closure synchronously inside
publication. That transaction cannot yield; its CPU cost must be measured.
Transfer retention does not reset the platform's CPU allowance or prove that a
particular repository fits the isolate memory limit.

## Alternatives considered

- Reuse the client push object array: retains the full graph in memory and
  carries unrelated push admission limits.
- Add temporary public refs or checkout journals: mixes transport lifetime with
  repository or checkout state visible to other operations.
- Ignore expired roots directly in GC queries: changes the root set with time
  without advancing the epoch that fences destructive maintenance.
- Keep physical readers across network waits: object retention does not retain
  a particular loose or packed representation during repacking.
