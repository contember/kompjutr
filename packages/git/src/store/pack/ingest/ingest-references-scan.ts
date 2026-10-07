import { CorruptError } from "../../../common/errors.js";

const SPACE = 0x20;
const NUL = 0;
const OID_BYTES = 20;
/** `TreeParser` refuses a seventh mode byte; the scanner keeps that limit. */
const MAX_MODE_BYTES = 6;

const IN_MODE = 0;
const IN_NAME = 1;
const IN_OID = 2;

/**
 * A mode's bytes packed big-endian into one number; six bytes stay a safe
 * integer. Leading NUL bytes do not change the key, so a match also compares length.
 */
function modeKey(mode: string): number {
  let key = 0;
  for (let index = 0; index < mode.length; index++) key = key * 256 + mode.charCodeAt(index);
  return key;
}

const TREE_MODE = modeKey("40000");
const PADDED_TREE_MODE = modeKey("040000");
const GITLINK_MODE = modeKey("160000");
const SHORT_MODE_BYTES = 5;

/** Receives each referenced entry's OID as five big-endian words; the array is reused. */
export type TreeReferenceSink = (oid: Uint32Array, type: "tree" | "blob") => void;

/**
 * Incremental raw-tree scanner for the pack reference collector (ADR-0029).
 * It reads each entry's mode and OID bytes and skips the name, so it holds no
 * entry across chunks beyond a few counters. It rejects what `TreeParser`
 * rejects structurally, but it does not decode names: connectivity must
 * over-approximate references, as the maintenance fallback does (ADR-0030).
 * A gitlink is not reported.
 */
export class TreeReferenceScanner {
  readonly #oid = new Uint32Array(OID_BYTES / 4);
  readonly #sink: TreeReferenceSink;
  #state: number = IN_MODE;
  #mode = 0;
  #modeBytes = 0;
  #oidBytes = 0;

  constructor(sink: TreeReferenceSink) {
    this.#sink = sink;
  }

  /** Start a new tree, discarding any entry a failed scan left open. */
  reset(): void {
    this.#state = IN_MODE;
    this.#mode = 0;
    this.#modeBytes = 0;
    this.#oidBytes = 0;
  }

  push(chunk: Uint8Array): void {
    const end = chunk.length;
    let offset = 0;
    while (offset < end) {
      if (this.#state === IN_MODE) {
        const byte = chunk[offset++]!;
        if (byte === SPACE) {
          this.#state = IN_NAME;
        } else {
          if (this.#modeBytes === MAX_MODE_BYTES) throw new CorruptError("tree mode is too long");
          this.#mode = this.#mode * 256 + byte;
          this.#modeBytes++;
        }
      } else if (this.#state === IN_NAME) {
        const nul = chunk.indexOf(NUL, offset);
        if (nul < 0) return;
        offset = nul + 1;
        this.#state = IN_OID;
        this.#oidBytes = 0;
      } else {
        offset = this.#readOid(chunk, offset);
      }
    }
  }

  /** Throw `CorruptError` when the tree ends inside an entry. */
  finish(): void {
    if (this.#state !== IN_MODE || this.#modeBytes !== 0) {
      throw new CorruptError("malformed tree entry");
    }
  }

  /** Shift OID bytes into their words; each word takes exactly four, so no clearing is needed. */
  #readOid(chunk: Uint8Array, offset: number): number {
    const oid = this.#oid;
    const stop = Math.min(chunk.length, offset + OID_BYTES - this.#oidBytes);
    let read = this.#oidBytes;
    for (let at = offset; at < stop; at++, read++) {
      const word = read >>> 2;
      oid[word] = (oid[word]! << 8) | chunk[at]!;
    }
    this.#oidBytes = read;
    if (read === OID_BYTES) this.#emit();
    return stop;
  }

  #emit(): void {
    const mode = this.#mode;
    const length = this.#modeBytes;
    this.#state = IN_MODE;
    this.#mode = 0;
    this.#modeBytes = 0;
    if (length === MAX_MODE_BYTES && mode === GITLINK_MODE) return;
    const subtree =
      (length === SHORT_MODE_BYTES && mode === TREE_MODE) ||
      (length === MAX_MODE_BYTES && mode === PADDED_TREE_MODE);
    this.#sink(this.#oid, subtree ? "tree" : "blob");
  }
}
