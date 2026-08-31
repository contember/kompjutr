/** Global routing spans repositories, so it has its own row and memory limits. */
export const MAX_ROUTING_CHECKOUTS = 8_192;
export const MAX_ROUTING_CHECKOUTS_RETAINED_BYTES = 16 * 1024 * 1024;
/** Root-only consumers retain less than the complete validated routing rows. */
export const MAX_ROUTING_ROOTS_UTF8_BYTES = 6 * 1024 * 1024;
