# bench

Standalone benchmark harness. `run.ts` spawns one child per scenario, optionally
inside a cgroup with a hard memory limit, and writes to `bench/results/`.

```bash
npm run bench          # every scenario
npm run bench:macro    # macro-packed, macro-loose
npm run bench:nextjs   # the Next.js workflow
npm run bench:statements -- --check  # deterministic SQL/row regression gate
npm run bench:clone-storage  # SQLite bytes a clone costs, and where they go
npm run bench:memory         # cgroup-backed bounded-memory evidence under cpu-lease
npm run bench:memory -- --runtime-check  # focused lease/cgroup wiring witness
npm run bench:workerd:nextjs # clone inside a real SQLite Durable Object
```

Scenarios: `synthetic.ts` isolates one variable at a time; `macro` replays the
reference experiment against real repositories; `shell` measures the command
surface; `nextjs-workflow.ts` runs clone through a 100-file commit and push;
`clone-storage.ts` sizes the database a clone leaves behind, against real git.
`statements.ts` checks correctness and frozen SQL/row baselines for operations
whose runtime query barriers were removed. It reports whether each row meets the
at-most-1,000-statement target. A target miss alone does not fail `--check` and
never licenses a runtime refusal; missing rows, invalid end states, and frozen-
baseline regressions do fail.
`memory.ts` exercises streamed operations above retired cumulative byte limits.
Its SQL target is report-only; semantic, coordinator, CPU-lease, and cgroup
validation failures are hard failures. The runner reserves its own CPU lease.
The <100 MiB process target is reset `VmHWM` minus its same-run baseline. The
independent 512 MiB cgroup cap includes SQLite page cache and is only a hard
runaway witness; raw cgroup totals are never presented as process memory.
Fixtures are `express`, `tailwind`, `vue`, `eslint`, `prettier`, `nextjs`
(218 → 24,252 files). `bench/results/` and `bench/.fixtures/` are gitignored.

## The number that matters

`commit` must not exhaust isolate memory at 985 tracked files. That ceiling —
not raw speed — is why the index is rows instead of one binary blob. The
current native snapshot is in `docs/reference/benchmark-current.md`; original targets and
legacy comparisons are under `docs/archive/benchmarks/`.

## Measurement rules — violating these produces a confident wrong number

1. **Wall time reported from inside a Worker is not a duration.** Cloudflare
   advances timers only at an I/O boundary, so a Durable Object cannot time
   synchronous SQLite work. Statement counts and rows read are the primary
   metrics. Wall time is meaningful only from local runs.
2. **Statement counts are deterministic; rows read are stable to about three
   significant figures.** Report both. Never round rows up into a claim.
3. **Small fixtures mislead.** Batching and read-ahead have a fixed cost a tiny
   tree cannot amortise — an apparent rows *regression* at 79 and 535 files
   disappears at 9,329. YOU MUST NOT headline a small-fixture number.
4. **`paths` bounds the checkout, not the fetch.** A subtree clone still
   downloads every blob, so a subtree fixture measures the whole pack.
5. **Compare like with like.** Never compare across filesystem modes or across
   object layouts and call the difference a result.
6. A `vitest-pool-workers` run needs a `compatibility_date` the bundled
   `workerd` supports. A date set to "today" makes the benchmark unrunnable.
7. Local workerd has no isolate memory limiter. Its process RSS is a regression
   signal, not proof that the production 128 MB isolate limit is satisfied.
8. The Next.js push phase must create a fresh remote branch. Setup and teardown
   delete `bench-work`, so a no-op push cannot masquerade as a measurement.
9. The Smart HTTP origin is an `http` server in the benchmark process. A child
   spawned with `execFileSync` — real `git`, for a baseline — blocks the event
   loop and deadlocks against it. Spawn asynchronously and await the exit.

Benchmark numbers taken on a loaded machine are noise. Reserve CPU before a run
and say in the write-up how it was reserved.
