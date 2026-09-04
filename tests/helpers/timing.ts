/**
 * Wall-clock assertions are opt-in:
 *
 *     KOMPJUTR_TIMING_GATE=1 npx vitest run tests/reads.test.ts
 *
 * Nothing sets it automatically, and that is deliberate — a duration bound
 * fails when the machine is busy, which tests the machine rather than the code
 * (`bench/CLAUDE.md` rule 1; real numbers come from `bench/`). Gate the
 * assertion, not the work: the operation still runs so its statement and row
 * counts stay covered.
 */
export const TIMING_GATE = process.env.KOMPJUTR_TIMING_GATE === "1";
