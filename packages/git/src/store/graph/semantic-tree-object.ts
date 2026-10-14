// Expands a reachable tree that has no complete projection by parsing its
// object bytes (ADR-0030). It writes no projection and bumps no generation:
// marking all of history must not project all of history.
//
// The durable cursor is the entry ordinal the projection path uses, so a tree
// projected between two steps resumes at the same edge. The byte offset of
// that entry is stored beside it, so a page starts where the last one ended;
// only a switch from the projection path (no offset yet) scans from entry 0.
// A maintenance call expands a paged tree's pages back to back over one read
// of its object; a later call reads it again, since the object cache refuses
// large values.

import { toHex, utf8Decoder } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import type { SharedRepoStore } from "../index.js";
import { treeModeEdge } from "./semantic-codecs.js";
import {
  EDGE_PAGE,
  type ObjectExpansion,
  type QueueObject,
  type ReachabilityEdge,
  type ReachabilityObjectInfo,
} from "./semantic-contracts.js";

const SPACE = 0x20;
const NUL = 0x00;
const SLASH = 0x2f;
const MAX_MODE_BYTES = 6;
const OID_BYTES = 20;

interface TreeEntryBounds {
  modeEnd: number;
  oidStart: number;
  next: number;
}

function entryBounds(data: Uint8Array, start: number): TreeEntryBounds {
  const modeEnd = data.indexOf(SPACE, start);
  if (modeEnd <= start || modeEnd - start > MAX_MODE_BYTES) {
    throw new CorruptError("tree entry mode is malformed");
  }
  const nameEnd = data.indexOf(NUL, modeEnd + 1);
  if (nameEnd <= modeEnd + 1 || data.subarray(modeEnd + 1, nameEnd).includes(SLASH)) {
    throw new CorruptError("tree entry name is malformed");
  }
  const next = nameEnd + 1 + OID_BYTES;
  if (next > data.length) throw new CorruptError("tree entry is truncated");
  return { modeEnd, oidStart: nameEnd + 1, next };
}

/** The last tree object read in one synchronous graph step; its expansions page through it. */
export class TreeObjectReads {
  #oid: string | null = null;
  #data: Uint8Array = new Uint8Array(0);

  read(store: SharedRepoStore, info: ReachabilityObjectInfo): Uint8Array {
    if (this.#oid === info.oid) return this.#data;
    const object = store.read(info.oid);
    if (object === null) throw new CorruptError(`reachable tree ${info.oid} disappeared`);
    if (object.type !== "tree" || object.data.length !== info.size) {
      throw new CorruptError("reachable tree disagrees with its indexed metadata");
    }
    this.#oid = info.oid;
    this.#data = object.data;
    return object.data;
  }
}

function cursorPosition(data: Uint8Array, object: QueueObject): number {
  if (object.edgeOffset !== null) {
    if (object.edgeOffset > data.length) {
      throw new CorruptError("tree edge offset exceeds its object");
    }
    return object.edgeOffset;
  }
  let position = 0;
  for (let ordinal = 0; ordinal < object.edgeCursor; ordinal++) {
    if (position === data.length) throw new CorruptError("tree edge cursor exceeds its entries");
    position = entryBounds(data, position).next;
  }
  return position;
}

export function treeObjectExpansion(
  store: SharedRepoStore,
  object: QueueObject,
  info: ReachabilityObjectInfo,
  trees: TreeObjectReads,
): ObjectExpansion {
  const data = trees.read(store, info);
  let position = cursorPosition(data, object);
  const edges: ReachabilityEdge[] = [];
  while (edges.length < EDGE_PAGE && position < data.length) {
    const entry = entryBounds(data, position);
    const mode = utf8Decoder.decode(data.subarray(position, entry.modeEnd));
    edges.push(treeModeEdge(mode, toHex(data.subarray(entry.oidStart, entry.next))));
    position = entry.next;
  }
  const complete = position === data.length;
  return {
    edges,
    nextCursor: object.edgeCursor + edges.length,
    nextOffset: complete ? null : position,
    complete,
  };
}
