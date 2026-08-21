// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the tree, commit and identity-line parsers are adapted from dgit's src/git/objects.ts.
//
// Git's four object types and their on-disk encodings. Everything here is
// pure: bytes in, structures out. Storage and delta resolution live
// elsewhere.

import { concat, isOid, toHex, utf8, utf8Decoder } from "./bytes.js";
import { CorruptError } from "./errors.js";
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
}

export const MODE_FILE = "100644";
export const MODE_EXECUTABLE = "100755";
export const MODE_SYMLINK = "120000";
export const MODE_TREE = "40000";
export const MODE_COMMIT = "160000";

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
  const { headers, message } = splitHeaders(utf8Decoder.decode(data));
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
      name: utf8Decoder.decode(data.subarray(space + 1, nul)),
      oid: toHex(data.subarray(nul + 1, nul + 21)),
    });
    pos = nul + 21;
  }
  return entries;
}

class ByteField {
  #bytes = new Uint8Array(64);
  #length = 0;

  constructor(
    private readonly limit: number,
    private readonly label: string,
  ) {}

  get length(): number {
    return this.#length;
  }

  push(byte: number): void {
    if (this.#length >= this.limit) throw new CorruptError(`tree ${this.label} is too long`);
    if (this.#length === this.#bytes.length) {
      const grown = new Uint8Array(Math.min(this.#bytes.length * 2, this.limit));
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
}

/** Parse raw tree chunks while retaining only the current entry. */
export function* parseTreeStream(chunks: Iterable<Uint8Array>): Generator<ParsedTreeEntry> {
  const mode = new ByteField(6, "mode");
  const name = new ByteField(2_200, "entry name");
  const oid = new Uint8Array(20);
  let state: "mode" | "name" | "oid" = "mode";
  let modeText = "";
  let nameBytes: Uint8Array = new Uint8Array(0);
  let oidAt = 0;
  for (const chunk of chunks) {
    for (const byte of chunk) {
      if (state === "mode") {
        if (byte === 0x20) {
          modeText = utf8Decoder.decode(mode.take());
          state = "name";
        } else {
          mode.push(byte);
        }
      } else if (state === "name") {
        if (byte === 0) {
          nameBytes = name.take();
          state = "oid";
          oidAt = 0;
        } else {
          name.push(byte);
        }
      } else {
        oid[oidAt++] = byte;
        if (oidAt === oid.length) {
          yield {
            entry: {
              mode: modeText,
              name: utf8Decoder.decode(nameBytes),
              oid: toHex(oid),
            },
            nameBytes,
            rawEntry: concat([
              utf8.encode(modeText),
              new Uint8Array([0x20]),
              nameBytes,
              new Uint8Array([0]),
              oid.slice(),
            ]),
          };
          state = "mode";
        }
      }
    }
  }
  if (state !== "mode" || mode.length !== 0) throw new CorruptError("malformed tree entry");
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
