import type { Commit } from "../src/git/common/objects.js";

const COMMIT_FIXED_CACHE_BYTES = 512;
const COMMIT_PARENT_CACHE_BYTES = 64;
const JSON_ENCODER = new TextEncoder();

/** Bench-local workload model for one cached commit-graph row (formerly in commits.ts). */
export function commitGraphBytes(commit: Commit): number {
  const textBytes =
    JSON_ENCODER.encode(commit.tree).byteLength +
    JSON_ENCODER.encode(JSON.stringify(commit.parent)).byteLength +
    JSON_ENCODER.encode(commit.author.name).byteLength +
    JSON_ENCODER.encode(commit.author.email).byteLength +
    JSON_ENCODER.encode(commit.committer.name).byteLength +
    JSON_ENCODER.encode(commit.committer.email).byteLength +
    JSON_ENCODER.encode(commit.message).byteLength +
    (commit.gpgsig === undefined ? 0 : JSON_ENCODER.encode(commit.gpgsig).byteLength);
  return (
    COMMIT_FIXED_CACHE_BYTES + 2 * textBytes + commit.parent.length * COMMIT_PARENT_CACHE_BYTES
  );
}
