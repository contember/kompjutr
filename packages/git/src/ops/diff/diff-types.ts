import { CorruptError, GitError } from "../../common/errors.js";
import type { DiffOptions, EndpointIdentity } from "./diff-internal.js";

export const DEFAULT_ABBREV = 7;
export const DIFF_WINDOW_ROWS = 1000;
export const DIFF_REPOSITORY_BYTES = 8 * 1024 * 1024;
export const DIFF_WORKTREE_BYTES = 8 * 1024 * 1024;
const MIB = 1024 * 1024;
export const DIFF_MAX_OUTPUT_BYTES = 16 * MIB;

export function diffStringBytes(value: string): number {
  return 48 + value.length * 2;
}

export interface DiffFormatOptions {
  /** Apply Git's C-style path quoting in patch headers. */
  quotePaths?: boolean;
  /** Escape non-ASCII UTF-8 bytes as octal when paths are quoted. */
  quoteNonAscii?: boolean;
  /** Compare the index to the worktree, as plain `git diff` does. */
  indexBase?: boolean;
  /** Bound rendered UTF-8 bytes before appending them. */
  maxOutputBytes?: number;
}

export type TreeDiffOptions = Pick<DiffOptions, "paths" | "context" | "abbrev" | "renames">;

/** One side of a file's change; null means the file is absent there. */
export interface Endpoint {
  mode: string;
  oid: string;
  bytes: Uint8Array | null;
}

export interface FileChange {
  path: string;
  originalPath?: string;
  similarity?: 100;
  before: Endpoint | null;
  after: Endpoint | null;
}

export interface CombinedFileChange {
  kind: "combined";
  path: string;
  parents: readonly [Endpoint, Endpoint];
  after: Endpoint | null;
}

export interface UnmergedPathChange {
  kind: "unmerged";
  path: string;
}

export type PatchChange = FileChange | CombinedFileChange | UnmergedPathChange;

export function isCombinedFileChange(change: PatchChange): change is CombinedFileChange {
  return "kind" in change && change.kind === "combined";
}

export function isUnmergedFileChange(change: PatchChange): change is UnmergedPathChange {
  return "kind" in change && change.kind === "unmerged";
}

export class DiffOutput {
  #bytes = 0;
  #output = "";
  readonly #maximum: number;

  constructor(maximum: number | undefined) {
    if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) {
      throw new GitError("EINVAL", "diff output ceiling must be a non-negative safe integer");
    }
    this.#maximum = Math.min(maximum ?? DIFF_MAX_OUTPUT_BYTES, DIFF_MAX_OUTPUT_BYTES);
  }

  append(value: string): void {
    if (value === "") return;
    const bytes = diffUtf8Bytes(value);
    if (bytes > this.#maximum - this.#bytes) {
      throw new GitError("E2BIG", `diff output exceeds ${this.#maximum} UTF-8 bytes`);
    }
    this.#bytes += bytes;
    this.#output += value;
  }

  outputCeiling(): number {
    return this.#maximum;
  }

  finish(): string {
    return this.#output;
  }
}

export function hydrateEndpoint(
  identity: EndpointIdentity | null,
  stored: ReadonlyMap<string, Uint8Array>,
  worktree: ReadonlyMap<string, Uint8Array>,
): Endpoint | null {
  if (identity === null) return null;
  const bytes =
    identity.worktree === null ? stored.get(identity.oid) : worktree.get(identity.worktree.path);
  return { mode: identity.mode, oid: identity.oid, bytes: bytes ?? null };
}

export function endpointBytes(endpoint: Endpoint): Uint8Array {
  if (endpoint.bytes === null) throw new CorruptError(`diff bytes missing for ${endpoint.oid}`);
  return endpoint.bytes;
}

function diffUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", "diff output must be well-formed UTF-16");
      }
      index++;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new GitError("EINVAL", "diff output must be well-formed UTF-16");
    } else {
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    if (!Number.isSafeInteger(bytes)) throw new GitError("E2BIG", "diff output is too large");
  }
  return bytes;
}
