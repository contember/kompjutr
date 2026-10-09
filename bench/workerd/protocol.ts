// Logged by the Durable Object after gc() returns. The forced GCs that precede it
// in the workerd trace bracket the measured region. The ordering holds because
// the V8 trace and console.log share workerd's line-buffered stdout.
export const GC_DONE_MARKER = "kompjutr-bench:gc-done";
// Logged with the statement count after the live-set GCs before that statement.
export const LIVE_SET_MARKER = "kompjutr-bench:live-set";
