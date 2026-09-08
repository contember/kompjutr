/** Bytes per statement, below the platform's 2 MB bound-value ceiling. */
export const DEFAULT_READ_BUDGET = 1_500_000;

/** Leaves room for query results and runtime overhead below the 100 MB gate. */
export const MAX_HANDLE_MATERIALIZE_BYTES = 32 * 1024 * 1024;
