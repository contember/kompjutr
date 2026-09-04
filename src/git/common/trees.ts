// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the tree, commit and identity-line parsers are adapted from dgit's src/git/objects.ts.
//
// Git's four object types and their on-disk encodings. Everything here is
// pure: bytes in, structures out. Storage and delta resolution live
// elsewhere.

import { concat, toHex, utf8, utf8Decoder } from "./bytes.js";
import { CorruptError, GitError } from "./errors.js";
import { comparePaths } from "./streams.js";

export interface TreeEntry {
  /** Raw git mode, e.g. "100644" for a file and "40000" for a subtree. */
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedTreeEntry {
  entry: TreeEntry;
  nameBytes: Uint8Array;
  rawEntry: Uint8Array;
  ordinal: number;
  observedSize: number;
}

export interface TreeParseResult {
  entryCount: number;
  observedSize: number;
}

export const MODE_FILE = "100644";
export const MODE_EXECUTABLE = "100755";
export const MODE_SYMLINK = "120000";
export const MODE_TREE = "40000";
export const MODE_COMMIT = "160000";

const treeNameDecoder = new TextDecoder("utf-8", { fatal: true });

/** Decode one authoritative tree name or composed tree path without byte loss. */
export function decodeTreeName(bytes: Uint8Array): string {
  try {
    return treeNameDecoder.decode(bytes);
  } catch {
    throw new GitError("EUNSUPPORTED", "tree names must be valid UTF-8");
  }
}

export function isTreeMode(mode: string): boolean {
  return mode === "40000" || mode === "040000";
}

/** Widen a raw tree mode to the six-digit form `ls-tree` prints. */
export function displayMode(mode: string): string {
  return mode.padStart(6, "0");
}

export function typeForMode(mode: string): "blob" | "tree" | "commit" {
  if (isTreeMode(mode)) return "tree";
  if (mode === MODE_COMMIT) return "commit";
  return "blob";
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    let space = pos;
    while (space < data.length && data[space] !== 0x20) space++;
    if (space >= data.length) throw new CorruptError("malformed tree entry");
    const mode = utf8Decoder.decode(data.subarray(pos, space));
    let nul = space + 1;
    while (nul < data.length && data[nul] !== 0) nul++;
    if (nul + 21 > data.length) throw new CorruptError("malformed tree entry");
    entries.push({
      mode,
      name: decodeTreeName(data.subarray(space + 1, nul)),
      oid: toHex(data.subarray(nul + 1, nul + 21)),
    });
    pos = nul + 21;
  }
  return entries;
}

class ByteField {
  #bytes: Uint8Array;
  #length = 0;

  constructor(
    private readonly limit: number | null,
    private readonly label: string,
  ) {
    this.#bytes = new Uint8Array(64);
  }

  get length(): number {
    return this.#length;
  }

  push(byte: number): void {
    if (this.limit !== null && this.#length >= this.limit) {
      throw new CorruptError(`tree ${this.label} is too long`);
    }
    if (this.#length === this.#bytes.length) {
      const next =
        this.limit === null ? this.#bytes.length * 2 : Math.min(this.#bytes.length * 2, this.limit);
      if (!Number.isSafeInteger(next) || next <= this.#bytes.length) {
        throw new GitError("E2BIG", `tree ${this.label} allocation exceeds the platform limit`);
      }
      let grown: Uint8Array<ArrayBuffer>;
      try {
        grown = new Uint8Array(next);
      } catch {
        throw new GitError("E2BIG", `tree ${this.label} allocation exceeds the platform limit`);
      }
      grown.set(this.#bytes);
      this.#bytes = grown;
    }
    this.#bytes[this.#length++] = byte;
  }

  take(): Uint8Array {
    const value = this.#bytes.slice(0, this.#length);
    this.#length = 0;
    return value;
  }

  dispose(): void {
    this.#bytes = new Uint8Array(0);
    this.#length = 0;
  }
}

/** Incremental raw-tree parser retaining only the entry currently crossing a chunk boundary. */
export class TreeParser {
  readonly #mode: ByteField;
  readonly #name: ByteField;
  #oid: Uint8Array;
  #state: "mode" | "name" | "oid" = "mode";
  #modeText = "";
  #modeBytes: Uint8Array = new Uint8Array(0);
  #nameBytes: Uint8Array = new Uint8Array(0);
  #oidAt = 0;
  #entryCount = 0;
  #observedSize = 0;
  #finished = false;

  constructor() {
    this.#mode = new ByteField(6, "mode");
    this.#name = new ByteField(null, "entry name");
    this.#oid = new Uint8Array(20);
  }

  *push(chunk: Uint8Array): Generator<ParsedTreeEntry> {
    if (this.#finished) throw new Error("tree parser is already finished");
    try {
      for (const byte of chunk) {
        this.#observedSize++;
        if (!Number.isSafeInteger(this.#observedSize)) {
          throw new CorruptError("tree object size exceeds the safe integer range");
        }
        if (this.#state === "mode") {
          if (byte === 0x20) {
            this.#modeBytes = this.#mode.take();
            this.#modeText = utf8Decoder.decode(this.#modeBytes);
            this.#state = "name";
          } else {
            this.#mode.push(byte);
          }
        } else if (this.#state === "name") {
          if (byte === 0) {
            this.#nameBytes = this.#name.take();
            this.#state = "oid";
            this.#oidAt = 0;
          } else {
            this.#name.push(byte);
          }
        } else {
          this.#oid[this.#oidAt++] = byte;
          if (this.#oidAt === this.#oid.length) {
            const modeText = this.#modeText;
            const modeBytes = this.#modeBytes;
            const nameBytes = this.#nameBytes;
            const rawEntryBytes = modeBytes.length + nameBytes.length + 22;
            const rawEntry = new Uint8Array(rawEntryBytes);
            rawEntry.set(modeBytes, 0);
            rawEntry[modeBytes.length] = 0x20;
            rawEntry.set(nameBytes, modeBytes.length + 1);
            rawEntry[modeBytes.length + nameBytes.length + 1] = 0;
            rawEntry.set(this.#oid, rawEntry.length - this.#oid.length);
            const name = decodeTreeName(nameBytes);
            const oid = toHex(this.#oid);
            const ordinal = this.#entryCount++;
            this.#state = "mode";
            this.#modeText = "";
            this.#modeBytes = new Uint8Array(0);
            this.#nameBytes = new Uint8Array(0);
            yield {
              entry: { mode: modeText, name, oid },
              nameBytes,
              rawEntry,
              ordinal,
              observedSize: this.#observedSize,
            };
          }
        }
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  finish(): TreeParseResult {
    if (this.#finished) throw new Error("tree parser is already finished");
    this.#finished = true;
    try {
      if (this.#state !== "mode" || this.#mode.length !== 0) {
        throw new CorruptError("malformed tree entry");
      }
      return { entryCount: this.#entryCount, observedSize: this.#observedSize };
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    this.#mode.dispose();
    this.#name.dispose();
    this.#oid = new Uint8Array(0);
    this.#modeBytes = new Uint8Array(0);
    this.#nameBytes = new Uint8Array(0);
    this.#modeText = "";
  }
}

/** Parse raw tree chunks while retaining only the current entry. */
export function* parseTreeStream(chunks: Iterable<Uint8Array>): Generator<ParsedTreeEntry> {
  const parser = new TreeParser();
  try {
    for (const chunk of chunks) yield* parser.push(chunk);
    parser.finish();
  } finally {
    parser.dispose();
  }
}

/**
 * Git's tree ordering: plain byte order over the name, except a subtree
 * sorts as though its name ended in "/". Get this wrong and every tree
 * hashes differently from the one real git would write.
 */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  // comparePaths gives the same byte order without encoding anything; this
  // runs O(w log w) times per tree, so two buffers per call was the cost of
  // writing one wide directory.
  return comparePaths(
    isTreeMode(a.mode) ? `${a.name}/` : a.name,
    isTreeMode(b.mode) ? `${b.name}/` : b.name,
  );
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    // Trees are written with the leading zero stripped, the way git does.
    const mode = entry.mode.replace(/^0+/, "");
    parts.push(utf8.encode(`${mode} ${entry.name}\0`));
    const oid = new Uint8Array(20);
    for (let i = 0; i < 20; i++) oid[i] = Number.parseInt(entry.oid.slice(i * 2, i * 2 + 2), 16);
    parts.push(oid);
  }
  return concat(parts);
}
