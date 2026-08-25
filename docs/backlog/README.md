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
  [30](30-rm-removes-worktree-files.md) ·
  [31](31-status-unmerged-and-options.md) ·
  [32](32-refuse-empty-commits.md) ·
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

## Items

- [04 — Add incremental repack and garbage collection](04-repack-and-garbage-collection.md)
- [05 — Establish CI and release gates](05-ci-and-release-gates.md)
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
- [19 — Align foreign-key enforcement between tests and production](19-foreign-key-enforcement-parity.md)
- [20 — Settle the role of `git_blob_ids` and bound its growth](20-blob-id-mapping-role-and-growth.md)
- [21 — Narrow the parsed-tree table keys and remove the duplicated entry name](21-narrow-parsed-tree-keys.md)
- [22 — Decide the OID column encoding before data volume locks it in](22-oid-column-encoding.md)
- [23 — Add write-time CHECK constraints to the derived commit and tree tables](23-write-time-checks-on-derived-tables.md)
- [25 — Add explicit rebase targets and roots](25-rebase-targets-and-roots.md)
- [26 — Add programmable interactive rebase](26-interactive-rebase.md)
- [27 — Replay merge topology during rebase](27-rebase-merges.md)
- [28 — Compose pull with native rebase](28-pull-rebase.md)
- [29 — Update dependent refs after rebase](29-rebase-update-refs.md)
- [30 — Remove working-tree files in `rm`](30-rm-removes-worktree-files.md)
- [31 — Report unmerged paths in `status` and expose its full option set](31-status-unmerged-and-options.md)
- [32 — Refuse an empty commit unless it is explicitly allowed](32-refuse-empty-commits.md)
- [33 — Enforce the merged check on branch deletion](33-branch-delete-merged-check.md)
- [34 — Detect renames in status and diff](34-rename-detection.md)
- [35 — Add a staged diff mode](35-staged-diff.md)
- [36 — Support glob pathspecs](36-glob-pathspecs.md)
- [37 — Complete history reads — patch output for `show`, path filter for `log`](37-history-reads-patch-and-paths.md)
- [38 — Align clone depth with Git and allow deepening](38-clone-depth-and-deepening.md)
- [39 — Complete the plumbing read surface](39-plumbing-read-surface.md)
