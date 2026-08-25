# backlog

Decided work items ("issues") not yet scheduled into a sprint. One self-contained
file per item: `NN-<slug>.md` (zero-padded, **folder-local** sequence — don't
renumber, gaps are fine). Copy [`_template.md`](_template.md).

**No `status:` field** — an item is alive because it lives here. It leaves by being
**deleted** on ship (default; git holds the record) or moved to `../archive/` if it
documents something a future reader needs. Dependencies go in frontmatter:
`blocked-by: [./NN-other.md]`.

Add scope sub-folders (`security/`, `perf/`, …) only once the flat list gets
unwieldy; numbers stay folder-local.

## Git parity tiers

Ranking of the gaps recorded in
[`../reference/git-support.md`](../reference/git-support.md). Tier is severity,
not effort: a wrong answer outranks a missing one.

- **S — silent divergence.** kompjutr returns a plausible result where Git
  returns a different one or refuses. Nothing warns the caller.
  [31](31-status-unmerged-and-options.md) ·
  [33](33-branch-delete-merged-check.md) ·
  [34](34-rename-detection.md)
- **A — blocks a common workflow, loudly.** The call fails or the capability is
  absent; no data is at risk.
  [35](35-staged-diff.md) ·
  [36](36-glob-pathspecs.md) ·
  [37](37-history-reads-patch-and-paths.md) ·
  [38](38-clone-depth-and-deepening.md) ·
  [39](39-plumbing-read-surface.md) ·
  [06](06-stash-operations.md) ·
  [18](18-branch-and-remote-management.md) ·
  [28](28-pull-rebase.md)
- **B — real gap, narrower audience or a workaround exists.**
  [08](08-extend-push-refspecs.md) ·
  [12](12-reflogs-and-ref-recovery.md) ·
  [13](13-force-with-lease.md) ·
  [25](25-rebase-targets-and-roots.md) ·
  [26](26-interactive-rebase.md) ·
  [27](27-rebase-merges.md) ·
  [29](29-rebase-update-refs.md)
- **C — deliberately out of scope.** Not filed: `bisect`, `blame`, `describe`,
  `shortlog`, `grep`, `archive`, `bundle`, `am`/`apply`/`format-patch`,
  submodules, worktrees, notes, hooks, signing, credential helpers, LFS,
  `.gitattributes` filters, config scopes, `clean -x`, SSH transport. Reopen a
  case for one only with a concrete workload behind it.

## Recommended implementation order

This is the default priority at the current HEAD, not scheduling state. Items in
the same phase may run in parallel, but a blocked item must not move ahead of its
blocker. Re-evaluate the order after each phase as production evidence arrives.

1. **Remove remaining silent Git divergences:**
   [31](31-status-unmerged-and-options.md) and
   [34](34-rename-detection.md). Correct plausible-but-wrong results before
   adding more surface area.
2. **Settle storage contracts before data volume grows:**
   [20](20-blob-id-mapping-role-and-growth.md),
   [21](21-narrow-parsed-tree-keys.md), and
   [23](23-write-time-checks-on-derived-tables.md).
3. **Build recovery before destructive maintenance:**
   [12](12-reflogs-and-ref-recovery.md), then
   [33](33-branch-delete-merged-check.md) and
   [04](04-repack-and-garbage-collection.md). Reflogs are the retention and
   recovery prerequisite for both follow-ups.
4. **Qualify the production runtime:** [10](10-worktree-wall-time.md),
   [11](11-production-do-regression-probe.md), and
   [16](16-concurrent-and-restart-conformance.md). Treat each as its own large
   work unit; the production probe is now unblocked by the verified CI/release
   seam.
5. **Add the highest-return daily workflows:**
   [38](38-clone-depth-and-deepening.md), [28](28-pull-rebase.md),
   [35](35-staged-diff.md), [36](36-glob-pathspecs.md),
   [37](37-history-reads-patch-and-paths.md), [13](13-force-with-lease.md),
   [15](15-abortable-network-operations.md), and [06](06-stash-operations.md).
6. **Broaden management and diagnostic surfaces:**
   [18](18-branch-and-remote-management.md),
   [08](08-extend-push-refspecs.md), [25](25-rebase-targets-and-roots.md),
   [39](39-plumbing-read-surface.md), and
   [17](17-integrity-audit-and-snapshots.md).
7. **Defer until a concrete workload justifies them:**
   [09](09-outbound-delta-compression.md), [26](26-interactive-rebase.md),
   [27](27-rebase-merges.md), and [29](29-rebase-update-refs.md). Item 29 also
   remains blocked by 12.

Before scheduling them, split 04, 16, 17, and 39 into smaller work units with
independent witnesses. Their current acceptance scopes are larger than one
focused sprint.

## Items

- [04 — Add incremental repack and garbage collection](04-repack-and-garbage-collection.md)
- [06 — Implement stash operations](06-stash-operations.md)
- [08 — Extend push refspec support](08-extend-push-refspecs.md)
- [09 — Add outbound delta compression](09-outbound-delta-compression.md)
- [10 — Close worktree wall-time gaps](10-worktree-wall-time.md)
- [11 — Add a production Durable Object regression probe](11-production-do-regression-probe.md)
- [12 — Add reflogs and ref recovery](12-reflogs-and-ref-recovery.md)
- [13 — Add force-with-lease push](13-force-with-lease.md)
- [15 — Make network operations abortable](15-abortable-network-operations.md)
- [16 — Verify concurrent and interrupted operations](16-concurrent-and-restart-conformance.md)
- [17 — Add repository integrity audit and snapshots](17-integrity-audit-and-snapshots.md)
- [18 — Complete branch and remote management](18-branch-and-remote-management.md)
- [20 — Settle the role of `git_blob_ids` and bound its growth](20-blob-id-mapping-role-and-growth.md)
- [21 — Narrow the parsed-tree table keys and remove the duplicated entry name](21-narrow-parsed-tree-keys.md)
- [23 — Add write-time CHECK constraints to the derived commit and tree tables](23-write-time-checks-on-derived-tables.md)
- [25 — Add explicit rebase targets and roots](25-rebase-targets-and-roots.md)
- [26 — Add programmable interactive rebase](26-interactive-rebase.md)
- [27 — Replay merge topology during rebase](27-rebase-merges.md)
- [28 — Compose pull with native rebase](28-pull-rebase.md)
- [29 — Update dependent refs after rebase](29-rebase-update-refs.md)
- [31 — Report unmerged paths in `status` and expose its full option set](31-status-unmerged-and-options.md)
- [33 — Enforce the merged check on branch deletion](33-branch-delete-merged-check.md)
- [34 — Detect renames in status and diff](34-rename-detection.md)
- [35 — Add a staged diff mode](35-staged-diff.md)
- [36 — Support glob pathspecs](36-glob-pathspecs.md)
- [37 — Complete history reads — patch output for `show`, path filter for `log`](37-history-reads-patch-and-paths.md)
- [38 — Align clone depth with Git and allow deepening](38-clone-depth-and-deepening.md)
- [39 — Complete the plumbing read surface](39-plumbing-read-surface.md)
