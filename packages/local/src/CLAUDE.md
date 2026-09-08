# @kompjutr/local

Unix Node.js composition over `node:sqlite` and a host disk working tree.

## Critical invariants

- Map virtual `/` to the configured project root. Resolve caller paths through
  `PathMapper`; reject lexical escapes and every symlink escape visible during
  resolution. Pure Node cannot close a hostile concurrent ancestor-swap race;
  callers that ignore the lifetime lock must not rewrite directory topology.
- Reject exact directory aliases. Pre-existing bind aliases of nested
  directories are unsupported because portable Node APIs expose no mount-aware
  ancestry check.
- Keep SQLite, the process lock, recovery generations, and traversal spill runs
  outside the worktree.
- Run every drive mutation inside `NodeSqliteDatabase.transactionSync()` with
  the database and drive sharing one `RecoveryCoordinator` mutation scope.
- Journal and fsync an intent before each observable filesystem effect. Move an
  existing path to its first-touch backup before replacement. Fsync replacement
  data before rename and sync both changed parent directories.
- Qualify backup renames with `st_dev` and a journaled live rename probe for
  every distinct existing source parent. A device number alone is insufficient
  across bind-mount boundaries.
- Publish the recovery generation in the SQLite commit. Settlement must be
  idempotent and classify every reopen as old generation or committed
  generation.
- Keep disk `contentId` as `null`. Correctness rehashes host content instead of
  trusting inode, size, or timestamp equality.
- Stream traversals in Git UTF-8 path order. Wide-directory sorting uses bounded
  runs and fan-in; never materialize the whole tree.

## Boundaries

- Node-only imports belong here, not in Worker-facing package graphs.
- The lifetime process lock is a root-keyed SQLite exclusive transaction in a
  sibling file; process death releases it in the kernel.
- Transaction SQL is allowed only in the `sqlite/` Node adapter; shared code
  calls `transactionSync()`.
- Use stable `error.code` values. Fail closed on journal corruption or a changed
  recovery path.

## Focused checks

```bash
npx vitest run tests/local
npm run typecheck
npm run package:smoke
npm run test:local-mounts
```
