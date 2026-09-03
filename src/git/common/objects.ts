// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the tree, commit and identity-line parsers are adapted from dgit's src/git/objects.ts.
//
// Git's four object types and their on-disk encodings. Everything here is
// pure: bytes in, structures out. Storage and delta resolution live
// elsewhere.

import { isOid, toHex, utf8, utf8Decoder } from "./bytes.js";
import { CorruptError, GitError } from "./errors.js";
import { Sha1 } from "./sha1.js";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

/** An object as it exists once inflated and delta-resolved. */
export interface RawObject {
  type: ObjectType;
  data: Uint8Array;
}

/**
 * Largest object the store accepts. A read materialises one object as a single
 * buffer inside a Workers isolate, so this is what keeps an object clear of the
 * 128 MiB isolate ceiling and the sub-100 MiB per-operation target.
 */
export const MAX_OBJECT_BYTES = 48 * 1024 * 1024;

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

export {
  compareTreeEntries,
  decodeTreeName,
  displayMode,
  isTreeMode,
  MODE_COMMIT,
  MODE_EXECUTABLE,
  MODE_FILE,
  MODE_SYMLINK,
  MODE_TREE,
  type ParsedTreeEntry,
  parseTree,
  parseTreeStream,
  serializeTree,
  type TreeEntry,
  type TreeParseResult,
  TreeParser,
  typeForMode,
} from "./trees.js";
