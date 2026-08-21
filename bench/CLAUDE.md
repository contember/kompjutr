# bench

Standalone benchmark harness. `run.ts` spawns one child per scenario, optionally
inside a cgroup with a hard memory limit, and writes to `bench/results/`.

```bash
npm run bench          # every scenario
npm run bench:macro    # macro-packed, macro-loose
npm run bench:nextjs   # the Next.js workflow
```

Scenarios: `synthetic.ts` isolates one variable at a time; `macro` replays the
reference experiment against real repositories; `shell` measures the command
surface. Fixtures are `express`, `tailwind`, `vue`, `eslint`, `prettier`,
`nextjs` (218 → 24,252 files). `bench/results/` and `bench/.fixtures/` are
gitignored.

## The number that matters

`commit` must not exhaust isolate memory at 985 tracked files. That ceiling —
not raw speed — is why the index is rows instead of one binary blob. The
targets and how they came out are in `docs/benchmark-reference.md` and
`docs/benchmark-macro.md`.

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

Benchmark numbers taken on a loaded machine are noise. Reserve CPU before a run
and say in the write-up how it was reserved.
