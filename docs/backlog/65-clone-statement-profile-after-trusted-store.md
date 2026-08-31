# Profile the clone statement growth after the trusted-store rewrite

The restructure sprint's informative `bench:nextjs` rows show clone wall time
improved (11,629 ms → 9,933 ms, −15 %) while the statement count roughly
doubled (824 → 1,613; rows read 78,537 → 79,265). The publication re-read
audit is gone, so the growth comes from elsewhere — the prime suspect is the
commit cache now always flushing (the ledger gate that silently skipped
flushes was deleted), plus the smaller per-family write paths.

Work:

- Profile a leased `bench:nextjs` clone with the statement histogram and
  attribute the delta to specific query shapes.
- Decide per shape: batch it, accept it (statement targets are informative,
  ADR-0017), or restore an intentional skip with a named structural reason.
- Refresh `docs/reference/benchmark-current.md` with a new median-of-three
  snapshot afterwards; the current one predates the sprint.

Not a correctness issue: all closure gates are green and wall time improved.
