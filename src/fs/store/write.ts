// P3 — the bulk write, and the reason the runtime exists at all. A checkout
// of 9,329 files costs ~420,000 statements through a per-path API; through
// this one it costs a constant handful of metadata statements plus one per
// payload budget of content.
//
// Every statement here is one of two shapes, both from §7.0 of
// docs/archive/plans/standalone-runtime.md:
//
//   * metadata rows carry no BLOBs, so they are fed straight from
//     `json_each(?)` — one statement for thousands of rows;
//   * rows carrying bytes use the concatenated-payload form — one payload
//     BLOB plus a JSON offset array, cut apart with `substr()`.
//
// `substr()` counts BYTES over a BLOB and CHARACTERS over TEXT. Only the
// chunk payload and the `content_id` payload are BLOBs, so byte offsets are
// correct there; every path and every symlink target travels inside the
// JSON, where the question never arises.
//
// `WHERE true` before `ON CONFLICT` is mandatory, not decorative: SQLite
// cannot parse an upsert on a SELECT-fed INSERT without it.

import type { SqlDatabase } from "../../db/db.js";
import { filesystemError as fsError } from "../errors.js";
import { comparePaths } from "../path.js";
import { CHUNK_SIZE } from "../schema.js";
import type { EntryType, WriteEntry, WriteOptions } from "../types.js";
import { allocateInodes, bumpRev } from "./meta.js";
import { realpathsNoFollow } from "./resolve.js";
import {
  deleteChunks,
  payloadBudgetOf,
  selectExistingRows,
  utf8Length,
  type WriteChunkRow,
  type WriteNodeRow,
  type WritePathRow,
  writeChunks,
  writeNodes,
  writePaths,
} from "./write-batches.js";

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
/** POSIX reports 0777 for every symlink, and so does dofs (`fs/symlink.ts:61`). */
const DEFAULT_SYMLINK_MODE = 0o777;
const MODE_BITS = 0o7777;

interface Planned {
  path: string;
  type: EntryType;
  mode: number;
  mtime: number;
  bytes: Uint8Array | null;
  target: string | null;
  contentId: Uint8Array | null;
}

interface ExistingRow {
  path: string;
  inode: number;
  type: EntryType;
}

function parentOf(path: string): string {
  if (path === "/") return "";
  const slash = path.lastIndexOf("/");
  return slash === 0 ? "/" : path.slice(0, slash);
}

/** Every ancestor of `path` except the root, which is always a directory. */
function strictAncestors(path: string): string[] {
  const out: string[] = [];
  let slash = path.indexOf("/", 1);
  while (slash > 0) {
    out.push(path.slice(0, slash));
    slash = path.indexOf("/", slash + 1);
  }
  return out;
}

function toPlanned(path: string, entry: WriteEntry, now: number): Planned {
  if (entry.target !== undefined && entry.bytes !== undefined) {
    throw fsError("EINVAL", "a write entry carries both bytes and a symlink target", path);
  }
  const mtime = entry.mtime ?? now;
  const contentId = entry.contentId ?? null;
  if (entry.target !== undefined) {
    return {
      path,
      type: "symlink",
      mode: (entry.mode ?? DEFAULT_SYMLINK_MODE) & MODE_BITS,
      mtime,
      bytes: null,
      target: entry.target,
      contentId,
    };
  }
  if (entry.bytes !== undefined) {
    return {
      path,
      type: "file",
      mode: (entry.mode ?? DEFAULT_FILE_MODE) & MODE_BITS,
      mtime,
      bytes: entry.bytes,
      target: null,
      contentId,
    };
  }
  return {
    path,
    type: "dir",
    mode: (entry.mode ?? DEFAULT_DIR_MODE) & MODE_BITS,
    mtime,
    bytes: null,
    target: null,
    contentId: null,
  };
}

function implicitDirectory(inode: number, now: number): WriteNodeRow {
  return {
    inode,
    type: "dir",
    mode: DEFAULT_DIR_MODE,
    mtime: now,
    size: 0,
    target: null,
    contentId: null,
  };
}

function nodeRowOf(entry: Planned, inode: number): WriteNodeRow {
  let size = 0;
  if (entry.type === "file") size = entry.bytes?.length ?? 0;
  // POSIX: a symlink's size is the byte length of its target.
  else if (entry.type === "symlink") size = utf8Length(entry.target ?? "");
  return {
    inode,
    type: entry.type,
    mode: entry.mode,
    mtime: entry.mtime,
    size,
    target: entry.target,
    contentId: entry.contentId,
  };
}

/**
 * Create or overwrite many entries in a constant number of metadata
 * statements plus one per `payloadBudget` of content.
 *
 * Directories, files and symlinks may be mixed. Entries are applied in path
 * order, so a parent directory always lands before its children, and a
 * duplicate path is resolved last-one-wins.
 *
 * An existing directory is left exactly as it is — not re-created, not
 * re-timestamped — whether it was named explicitly or implied by
 * `parents`. Overwriting a file replaces its bytes and drops every stale
 * chunk, so a shorter overwrite cannot leave the previous tail readable,
 * and it clears `content_id` unless the caller supplies a new one.
 */
export function writeFiles(
  db: SqlDatabase,
  entries: readonly WriteEntry[],
  options: WriteOptions = {},
  now: () => number = Date.now,
): void {
  if (entries.length === 0) return;
  const createParents = options.parents !== false;
  const budget = payloadBudgetOf(options.payloadBudget);
  const timestamp = now();

  db.transactionSync(() => {
    const real = realpathsNoFollow(
      db,
      entries.map((entry) => entry.path),
    );

    const planned = new Map<string, Planned>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const path = real[i];
      if (entry === undefined || path === undefined) continue;
      planned.set(path, toPlanned(path, entry, timestamp));
    }
    // Path order throughout, so the batch is deterministic and a parent is
    // always considered before its children.
    const targets = [...planned.values()].sort((a, b) => comparePaths(a.path, b.path));

    // Directories the entries need but did not name themselves.
    const required = new Set<string>();
    for (const target of targets) {
      for (const ancestor of strictAncestors(target.path)) {
        const named = planned.get(ancestor);
        if (named === undefined) {
          required.add(ancestor);
          continue;
        }
        if (named.type !== "dir") {
          throw fsError("ENOTDIR", "a parent path segment is not a directory", ancestor);
        }
      }
    }

    const existing = new Map<string, ExistingRow>();
    const probe = [...required, ...targets.map((target) => target.path)];
    for (const row of selectExistingRows<ExistingRow>(db, probe)) {
      existing.set(row.path, row);
    }

    const creating: string[] = [];
    for (const path of required) {
      const found = existing.get(path);
      if (found === undefined) {
        if (!createParents) throw fsError("ENOENT", "parent directory missing", path);
        creating.push(path);
        continue;
      }
      if (found.type !== "dir") {
        throw fsError("ENOTDIR", "a parent path segment is not a directory", path);
      }
    }

    const overwriting: Planned[] = [];
    const replaced: number[] = [];
    for (const entry of targets) {
      const found = existing.get(entry.path);
      if (found === undefined) {
        creating.push(entry.path);
        continue;
      }
      if (found.type === "dir" && entry.type === "dir") continue; // left alone
      if (found.type === "dir") throw fsError("EISDIR", "cannot replace a directory", entry.path);
      if (entry.type === "dir") {
        throw fsError("EEXIST", "cannot replace a file with a directory", entry.path);
      }
      overwriting.push(entry);
      replaced.push(found.inode);
    }

    if (creating.length === 0 && overwriting.length === 0) return;

    // Path order, so inodes ascend with paths and a parent row is both
    // built and inserted before any of its children.
    creating.sort(comparePaths);

    const rev = bumpRev(db);
    const firstInode = creating.length > 0 ? allocateInodes(db, creating.length) : 0;

    const inodes = new Map<string, number>();
    const nodes: WriteNodeRow[] = [];
    const paths: WritePathRow[] = [];
    for (let i = 0; i < creating.length; i++) {
      const path = creating[i];
      if (path === undefined) continue;
      const inode = firstInode + i;
      const entry = planned.get(path);
      inodes.set(path, inode);
      nodes.push(
        entry === undefined ? implicitDirectory(inode, timestamp) : nodeRowOf(entry, inode),
      );
      paths.push({ path, parent: parentOf(path), inode });
    }
    for (let i = 0; i < overwriting.length; i++) {
      const entry = overwriting[i];
      const inode = replaced[i];
      if (entry === undefined || inode === undefined) continue;
      inodes.set(entry.path, inode);
      nodes.push(nodeRowOf(entry, inode));
    }

    // Stale content dies before the new content lands, so a shorter
    // overwrite cannot leave the old tail behind.
    if (replaced.length > 0) {
      deleteChunks(db, replaced);
    }

    writeNodes(db, nodes, rev);
    writePaths(db, paths);

    const chunks: WriteChunkRow[] = [];
    for (const entry of targets) {
      if (entry.type !== "file" || entry.bytes === null) continue;
      const inode = inodes.get(entry.path);
      if (inode === undefined) continue;
      for (let at = 0, idx = 0; at < entry.bytes.length; at += CHUNK_SIZE, idx++) {
        chunks.push({ inode, idx, bytes: entry.bytes.subarray(at, at + CHUNK_SIZE) });
      }
    }
    writeChunks(db, chunks, budget);
  });
}

/**
 * Create directories, parents included, in a constant number of statements
 * however many are asked for. Existing ones are left alone, so a repeat
 * call writes nothing and does not move the revision.
 */
export function makeDirectories(
  db: SqlDatabase,
  paths: readonly string[],
  now: () => number = Date.now,
): void {
  writeFiles(
    db,
    paths.map((path) => ({ path })),
    { parents: true },
    now,
  );
}
