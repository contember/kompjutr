---
id: 65
title: Resolve verified Git SQLite architecture review findings
blocked-by: []
---

# 65 - Resolve verified Git SQLite architecture review findings

**Summary.** Resolve the verified open findings from the 2026-09-02
Git-in-SQLite architecture review as independent, small changes.

## Scope

The review verified each finding below with a second adversarial pass. Treat each
row as a candidate work unit and re-check its premise at HEAD before scheduling
it. Split a selected cluster into a sprint with focused witnesses; do not attempt
this entire item as one undifferentiated change.

Completed findings are removed when their response ships. The tables below
contain only open work.

ARCH-10 shipped with the 2026-09-10 sprint; ARCH-21 (the duplicate maintenance shallow table) and the unused pack membership digests were removed on 2026-09-24. ARCH-19 (the duplicate reflog-root
scan) and the rebase no-op admission cap went with the 2026-09-23 simplification
sprint. ARCH-47 is the [outbound delta compression idea](../ideas/outbound-delta-compression.md).
The status/rm slice of ARCH-17 shipped in the
[modeled-charge sprint](../archive/sprint-2026-09-26-retire-modeled-charges-and-twins.md);
checkout's remaining charges are tracked in [97](97-audit-checkout-modeled-byte-charges.md).

The 2026-09-24 backlog review dropped findings that would add machinery without
a measured cost or a reproduced defect: ARCH-16 (durable sweep cursors), ARCH-18
(ref-table scans at 100,000 refs), ARCH-20 (sparse range seeks), ARCH-22
(normalizing `git_pack_objects`), ARCH-30 (bulk `clean`) and ARCH-33/39 (guards
against misuse of a synchronous callback). Reopen one only with a measurement.
Unverified and disputed claims remain in
[`../ideas/git-sqlite-architecture-review-triage.md`](../ideas/git-sqlite-architecture-review-triage.md).

## 2026-09-08 follow-up and evidence boundaries

The follow-up reviewed the working tree containing the scoped-package extraction,
not a commit-only diff. Existing findings stay owned here.

Re-check current source before implementation. Review probes were temporary and
were removed; their reported output is evidence, not a committed regression
suite. Preserve these distinctions when planning acceptance:

| Existing finding | Qualified evidence and required witness |
|---|---|
| ARCH-27 | Public `updateRef` accepted a trailing unpaired high surrogate; stored text changed and original-name lookup failed. The input-changing fix and its witness are [96](96-validate-git-caller-utf8-at-boundaries.md). |

## Independent follow-ups

| Finding | Small change |
|---|---|
| ARCH-24/25 | [98 — Remove forwarding owner wrappers](98-remove-forwarding-owner-wrappers.md) |
| ARCH-26 | [99 — Simplify redundant checkout store reads](99-simplify-checkout-store-reads.md) |
| ARCH-27, equivalent helpers | [100 — Consolidate Git path and OID helpers](100-consolidate-equivalent-git-helpers.md) |
| ARCH-27, input acceptance | [96 — Reject noncanonical UTF-16 in caller text](96-validate-git-caller-utf8-at-boundaries.md) |
| ARCH-29 | [101 — Use tracked prefixes in status pruning](101-use-tracked-prefixes-in-status-pruning.md) |
| ARCH-34 | [102 — Consolidate equivalent store validators](102-consolidate-equivalent-store-validators.md) |
| ARCH-36 | [103 — Share reflog append plumbing](103-share-reflog-append-plumbing.md) |
| ARCH-40 | [104 — Move ref probes behind the store seam](104-move-ref-probes-behind-store-seam.md) |

## Cross-cutting acceptance

- Preserve ADR-0005's rule that cost is bounded structurally rather than through
  projected-work currencies.
- Preserve ADR-0004's boundary-validation and trusted-read model; no finding
  here is a reason to re-authenticate ordinary reads.
- Update [`benchmark-current`](../reference/benchmark-current.md) only from
  measurements run under `bench/CLAUDE.md` rules.
- Update living reference documentation in the same change as each behavior or
  limit change.

<!-- Origin: external Git-in-SQLite architecture review, 2026-09-02. -->
