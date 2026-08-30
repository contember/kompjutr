// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the tree, commit and identity-line parsers are adapted from dgit's src/git/objects.ts.
//
// Git's four object types and their on-disk encodings. Everything here is
// pure: bytes in, structures out. Storage and delta resolution live
// elsewhere.

import { MemoryCoordinator, type MemoryReservation } from "../memory.js";
import { concat, isOid, toHex, utf8, utf8Decoder } from "./bytes.js";
import { CorruptError, GitError } from "./errors.js";
import { Sha1 } from "./sha1.js";
import { comparePaths } from "./streams.js";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

/** An object as it exists once inflated and delta-resolved. */
export interface RawObject {
  type: ObjectType;
  data: Uint8Array;
}

export const TYPE_NUMBER: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const NUMBER_TYPE: Record<number, ObjectType> = {
  1: "commit",
  2: "tree",
  3: "blob",
  4: "tag",
};

export function objectHeader(type: ObjectType, size: number): Uint8Array {
  return utf8.encode(`${type} ${size}\0`);
}

export function hashObject(type: ObjectType, data: Uint8Array): string {
  return toHex(new Sha1().update(objectHeader(type, data.length)).update(data).digest());
}

/**
 * A commit or tag identity line. `timezoneOffset` follows the
 * `Date.prototype.getTimezoneOffset` convention isomorphic-git uses and
 * Computer's `CommitView` exposes: minutes *west* of UTC, so `+0100`
 * is `-60`.
 */
export interface Person {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

export interface Commit {
  tree: string;
  parent: string[];
  author: Person;
  committer: Person;
  gpgsig?: string;
  message: string;
}

export interface Tag {
  object: string;
  type: ObjectType;
  tag: string;
  tagger?: Person;
  message: string;
}

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

// -- identity lines ---------------------------------------------------

function formatTimezone(offsetMinutes: number): string {
  // Stored west-positive, written east-positive.
  const east = -offsetMinutes;
  const sign = east < 0 ? "-" : "+";
  const abs = Math.abs(east);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

export function formatPerson(person: Person): string {
  return `${person.name} <${person.email}> ${person.timestamp} ${formatTimezone(person.timezoneOffset)}`;
}

export function parsePerson(line: string): Person {
  // Linear scans, not a backtracking regex: this line comes from the
  // remote and can be arbitrarily long.
  const open = line.indexOf(" <");
  const close = open < 0 ? -1 : line.indexOf(">", open + 2);
  if (open < 0 || close < 0) {
    return { name: line, email: "", timestamp: 0, timezoneOffset: 0 };
  }
  const name = line.slice(0, open);
  const email = line.slice(open + 2, close);
  const rest = line
    .slice(close + 1)
    .trim()
    .split(" ");
  const timestamp = rest.length > 0 ? Number.parseInt(rest[0]!, 10) : 0;
  let timezoneOffset = 0;
  if (rest.length > 1 && /^[+-]\d{4}$/.test(rest[1]!)) {
    const zone = rest[1]!;
    const minutes = Number.parseInt(zone.slice(1, 3), 10) * 60 + Number.parseInt(zone.slice(3), 10);
    timezoneOffset = minutes === 0 ? 0 : zone[0] === "-" ? minutes : -minutes;
  }
  return {
    name,
    email,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    timezoneOffset,
  };
}

// -- header block -----------------------------------------------------

interface HeaderBlock {
  headers: [string, string][];
  message: string;
}

function splitHeaders(text: string): HeaderBlock {
  const blank = text.indexOf("\n\n");
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? "" : text.slice(blank + 2);
  const headers: [string, string][] = [];
  const continuations: string[][] = [];
  for (const line of head.split("\n")) {
    if (line.startsWith(" ") && headers.length > 0) {
      continuations[continuations.length - 1]!.push(line.slice(1));
      continue;
    }
    const space = line.indexOf(" ");
    if (space > 0) {
      headers.push([line.slice(0, space), line.slice(space + 1)]);
      continuations.push([]);
    }
  }
  for (let i = 0; i < headers.length; i++) {
    const extra = continuations[i]!;
    if (extra.length > 0) headers[i]![1] += `\n${extra.join("\n")}`;
  }
  return { headers, message };
}

// -- commit -----------------------------------------------------------

export function parseCommit(data: Uint8Array): Commit {
  return parseCommitText(utf8Decoder.decode(data));
}

function parseCommitText(text: string): Commit {
  const { headers, message } = splitHeaders(text);
  const commit: Commit = {
    tree: "",
    parent: [],
    author: { name: "", email: "", timestamp: 0, timezoneOffset: 0 },
    committer: { name: "", email: "", timestamp: 0, timezoneOffset: 0 },
    message,
  };
  let sawTree = false;
  for (const [key, value] of headers) {
    switch (key) {
      case "tree":
        if (!isOid(value)) throw new CorruptError("commit has a malformed tree oid");
        commit.tree = value;
        sawTree = true;
        break;
      case "parent":
        if (!isOid(value)) throw new CorruptError("commit has a malformed parent oid");
        commit.parent.push(value);
        break;
      case "author":
        commit.author = parsePerson(value);
        break;
      case "committer":
        commit.committer = parsePerson(value);
        break;
      case "gpgsig":
        commit.gpgsig = value;
        break;
      default:
        break;
    }
  }
  if (!sawTree) throw new CorruptError("commit is missing its tree header");
  return commit;
}

/** Replayed commits must round-trip through the string-only commit writer. */
export function parseReplayCommit(data: Uint8Array): Commit {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new GitError("EUNSUPPORTED", "replay does not support non-UTF-8 commit objects");
  }
  const blank = text.indexOf("\n\n");
  const head = blank < 0 ? text : text.slice(0, blank);
  for (const line of head.split("\n")) {
    if (line.startsWith("encoding ")) {
      throw new GitError("EUNSUPPORTED", "replay does not support commit encoding headers");
    }
  }
  return parseCommitText(text);
}

export function serializeCommit(commit: Commit): Uint8Array {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parent) lines.push(`parent ${parent}`);
  lines.push(`author ${formatPerson(commit.author)}`);
  lines.push(`committer ${formatPerson(commit.committer)}`);
  if (commit.gpgsig !== undefined) {
    lines.push(`gpgsig ${commit.gpgsig.split("\n").join("\n ")}`);
  }
  return utf8.encode(`${lines.join("\n")}\n\n${commit.message}`);
}

// -- tag --------------------------------------------------------------

export function parseTag(data: Uint8Array): Tag {
  const { headers, message } = splitHeaders(utf8Decoder.decode(data));
  const tag: Tag = { object: "", type: "commit", tag: "", message };
  let sawObject = false;
  for (const [key, value] of headers) {
    switch (key) {
      case "object":
        if (!isOid(value)) throw new CorruptError("tag has a malformed object oid");
        tag.object = value;
        sawObject = true;
        break;
      case "type":
        if (value !== "commit" && value !== "tree" && value !== "blob" && value !== "tag") {
          throw new CorruptError(`tag has an unknown target type ${value}`);
        }
        tag.type = value;
        break;
      case "tag":
        tag.tag = value;
        break;
      case "tagger":
        tag.tagger = parsePerson(value);
        break;
      default:
        break;
    }
  }
  if (!sawObject) throw new CorruptError("tag is missing its object header");
  return tag;
}

export function serializeTag(tag: Tag): Uint8Array {
  const lines = [`object ${tag.object}`, `type ${tag.type}`, `tag ${tag.tag}`];
  if (tag.tagger) lines.push(`tagger ${formatPerson(tag.tagger)}`);
  return utf8.encode(`${lines.join("\n")}\n\n${tag.message}`);
}

// -- tree -------------------------------------------------------------

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

  get retainedBytes(): number {
    return this.#bytes.length;
  }

  push(byte: number, admit: (transientBytes: number) => void, sync: () => void): void {
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
      admit(next);
      try {
        grown = new Uint8Array(next);
      } catch {
        throw new GitError("E2BIG", `tree ${this.label} allocation exceeds the platform limit`);
      }
      grown.set(this.#bytes);
      this.#bytes = grown;
      sync();
    }
    this.#bytes[this.#length++] = byte;
  }

  take(admit: (transientBytes: number) => void): Uint8Array {
    admit(this.#length);
    const value = this.#bytes.slice(0, this.#length);
    this.#length = 0;
    return value;
  }

  dispose(): void {
    this.#bytes = new Uint8Array(0);
    this.#length = 0;
  }
}

const TREE_PARSER_FIXED_BYTES = 64;
const TREE_PARSER_ENTRY_FIXED_BYTES = 256;

/** Incremental raw-tree parser retaining only the entry currently crossing a chunk boundary. */
export class TreeParser {
  readonly #reservation: MemoryReservation;
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

  constructor(owningReservation?: MemoryReservation) {
    this.#reservation = owningReservation?.scope() ?? new MemoryCoordinator().reserve();
    const initialBytes = 2 * 64 + 20 + TREE_PARSER_FIXED_BYTES;
    try {
      this.#reservation.set("tree", initialBytes);
      this.#mode = new ByteField(6, "mode");
      this.#name = new ByteField(null, "entry name");
      this.#oid = new Uint8Array(20);
    } catch (error) {
      this.#reservation.dispose();
      throw error;
    }
  }

  get retainedBytes(): number {
    if (this.#reservation.disposed) return 0;
    return this.#retainedBytes();
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
            this.#modeBytes = this.#mode.take((bytes) => this.#admit(bytes));
            this.#sync();
            this.#admit(this.#modeBytes.length * 2);
            this.#modeText = utf8Decoder.decode(this.#modeBytes);
            this.#sync();
            this.#state = "name";
          } else {
            this.#mode.push(
              byte,
              (bytes) => this.#admit(bytes),
              () => this.#sync(),
            );
          }
        } else if (this.#state === "name") {
          if (byte === 0) {
            this.#nameBytes = this.#name.take((bytes) => this.#admit(bytes));
            this.#sync();
            this.#state = "oid";
            this.#oidAt = 0;
          } else {
            this.#name.push(
              byte,
              (bytes) => this.#admit(bytes),
              () => this.#sync(),
            );
          }
        } else {
          this.#oid[this.#oidAt++] = byte;
          if (this.#oidAt === this.#oid.length) {
            const modeText = this.#modeText;
            const modeBytes = this.#modeBytes;
            const nameBytes = this.#nameBytes;
            const rawEntryBytes = modeBytes.length + nameBytes.length + 22;
            const projectedEntryBytes =
              TREE_PARSER_ENTRY_FIXED_BYTES +
              rawEntryBytes +
              nameBytes.length +
              (modeText.length + nameBytes.length + 40) * 2;
            this.#admit(projectedEntryBytes);
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
            this.#reservation.set(
              "tree",
              this.#retainedBytes() +
                TREE_PARSER_ENTRY_FIXED_BYTES +
                rawEntry.length +
                nameBytes.length +
                (modeText.length + name.length + oid.length) * 2,
            );
            try {
              yield {
                entry: { mode: modeText, name, oid },
                nameBytes,
                rawEntry,
                ordinal,
                observedSize: this.#observedSize,
              };
            } finally {
              if (!this.#reservation.disposed) this.#sync();
            }
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
    if (this.#reservation.disposed) return;
    this.#mode.dispose();
    this.#name.dispose();
    this.#oid = new Uint8Array(0);
    this.#modeBytes = new Uint8Array(0);
    this.#nameBytes = new Uint8Array(0);
    this.#modeText = "";
    this.#reservation.dispose();
  }

  #retainedBytes(): number {
    return (
      this.#mode.retainedBytes +
      this.#name.retainedBytes +
      this.#oid.length +
      this.#modeBytes.length +
      this.#nameBytes.length +
      this.#modeText.length * 2 +
      TREE_PARSER_FIXED_BYTES
    );
  }

  #admit(transientBytes: number): void {
    const retained = this.#retainedBytes();
    if (!Number.isSafeInteger(transientBytes) || transientBytes < 0) {
      throw new GitError("E2BIG", "tree parser memory accounting overflows");
    }
    this.#reservation.set("tree", retained + transientBytes);
  }

  #sync(): void {
    this.#reservation.set("tree", this.#retainedBytes());
  }
}

/** Parse raw tree chunks while retaining only the current entry. */
export function* parseTreeStream(
  chunks: Iterable<Uint8Array>,
  owningReservation?: MemoryReservation,
): Generator<ParsedTreeEntry> {
  const parser = new TreeParser(owningReservation);
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
