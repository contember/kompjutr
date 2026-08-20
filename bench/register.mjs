// Registers the loader hooks so `node bench/run.ts` can import this
// package's TypeScript sources directly. Vite is deliberately not used:
// its module graph would sit in the heap we are trying to measure.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
