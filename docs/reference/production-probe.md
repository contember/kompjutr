# Production Durable Object probe

The release-candidate probe runs the public Git client and filesystem against a
deployed SQLite-backed Durable Object. It is an operator workflow, not a normal
CI gate. Deploy or rotate its secret only with explicit authorization for the
selected Cloudflare account.

The retained Worker is named `kompjutr-git-probe`. Its Wrangler configuration
contains no account identifier or credential. A generated `PROBE_TOKEN` secret
protects every endpoint. Each run uses a unique named Durable Object; the
destructive storage-reset witness uses a second unique object.

## What it proves

One run executes these bounded requests:

1. Clone and fetch pinned refs from the public
   `octocat/Hello-World` fixture.
2. Mutate, add, commit, and create a real push pack. Push terminates at the
   probe's deterministic receive-pack transport; it does not write to GitHub.
3. Complete a clean rebase.
4. Suspend a conflicting rebase, force an isolate reset, reopen, resolve, and
   continue it.
5. Suspend a second conflicting rebase, force another reset, reopen, and abort
   it back to its original HEAD and worktree.
6. Return an application error without resetting the isolate.
7. Run `quick_check`, `foreign_key_check`, pending-pack and operation-journal
   checks, and require every repository to be clean.
8. Delete all storage in a disposable object, confirm the database shrinks,
   reset the isolate in a separate request, and require the marker to be absent
   after schema reconstruction.

The Worker counts SQL statements and returned rows per operation and reports the
at-most-1,000-statement optimization target. A target miss is evidence to
optimize, not a package runtime refusal. Responses still fail above the real
1 MiB probe transport bound. The Node runner measures wall time externally
because Worker timers do not measure synchronous SQLite work reliably.

## Operator commands

Install and validate without touching Cloudflare:

```bash
npm ci
npm run typecheck
npm run check
npm run probe:dry-run
```

After explicit deployment authorization, select the account outside tracked
configuration and deploy:

```bash
CLOUDFLARE_ACCOUNT_ID=... npm run probe:deploy
npx wrangler secret put PROBE_TOKEN --config bench/production/wrangler.jsonc
```

Wait for the secret version to propagate before running. Pass the deployed URL
and the same secret only through the environment:

```bash
KOMPJUTR_PROBE_URL=... KOMPJUTR_PROBE_TOKEN=... npm run probe:run
```

Workers analytics aggregate with a short delay. Query them after the run file
appears:

```bash
CLOUDFLARE_ACCOUNT_ID=... npm run probe:analytics -- \
  --evidence=bench/results/production-do-<run-id>.json
```

The runner writes full local results under gitignored `bench/results/`. Retain a
sanitized public witness under `bench/production/evidence/`; remove account
identifiers, account-specific URLs, client IP addresses, and Cloudflare error
HTML before adding it to Git.

## Current production witness

The current witness ran on 2026-08-27 in `PRG` against Worker deployment
`89c21685-4f39-4f62-98fe-3c6426081c96` with Wrangler 4.127.0. The source base
was commit `b821b1c8`; the probe files were uncommitted and are attributed by
SHA-256 `e65f5b390753eca49d70bd4c313b4bc254a99b17aea35a1326f25aa8c653ca4b`.
The unauthenticated control returned 401.

| Operation | External wall time | SQL statements | Rows returned |
|---|---:|---:|---:|
| Clone | 557.3 ms | 93 | 41 |
| Fetch | 421.2 ms | 41 | 26 |
| Mutate | 46.2 ms | 12 | 12 |
| Add | 63.1 ms | 46 | 42 |
| Commit | 60.6 ms | 58 | 47 |
| Push | 40.1 ms | 22 | 32 |
| Clean rebase | 173.6 ms | 296 | 350 |
| Conflicting rebase setup | 111.3 ms | 223 | 242 |
| Rebase continue | 84.5 ms | 192 | 197 |
| Conflicting abort setup | 133.5 ms | 223 | 243 |
| Rebase abort | 97.8 ms | 138 | 140 |
| Physical audit | 31.3 ms | 61 | 65 |

Every constructor observed `PRAGMA foreign_keys=1` before and after Git-store
initialization. The main object reopened at constructor ordinals 2 and 3 while
retaining each suspended rebase. The application failure retained ordinal 3.
The final audit returned `quick_check=ok`, no foreign-key violations, no pending
packs, no operation journals, four clean repositories, and 372,736 database
bytes. The disposable object's `deleteAll()` result was 4,096 bytes; a separate
isolate reset rebuilt the schema and the marker stayed absent.

The exact run window in `workersInvocationsAdaptive` reported three
`scriptThrewException` errors, all caused by the three requested isolate resets,
and no unexpected errors. The highest per-second bucket was
`cpuTimeP99=895` microseconds and `memoryUsageBytesP99=7,934,362` bytes. This
adaptive aggregate is a resource witness, not an exact request ledger; the
runner responses remain authoritative for request-by-request correctness and
cost.

Sanitized operation, restart, correctness, and analytics records are retained in
[`../../bench/production/evidence/2026-08-27-production-do.json`](../../bench/production/evidence/2026-08-27-production-do.json).
This is a small-fixture production witness. It does not replace the current
large-fixture local benchmark or prove all pairwise concurrency cases.
