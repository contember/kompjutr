import { CorruptError, GitError } from "../../common/errors.js";
import { hashObject, type ObjectType, parseTag, type RawObject } from "../../common/objects.js";
import type { Advertisement, RemoteRef } from "../../protocol/remote.js";
import { type FetchPublicationToken, PACK_BLOB_BATCH_TARGET_BYTES } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { AdvertisedTag } from "./network-types.js";

const TAG_OBJECT_PAGE = 4_096;
const TAG_PEEL_HOPS = 16;
const tagHeaderDecoder = new TextDecoder("utf-8", { fatal: true });

export function advertisedTags(advertisement: Advertisement): AdvertisedTag[] {
  const peeled = new Map<string, string>();
  for (const ref of advertisement.refs) {
    if (ref.name.startsWith("refs/tags/") && ref.name.endsWith("^{}")) {
      peeled.set(ref.name.slice(0, -3), ref.oid);
    }
  }
  const tags: AdvertisedTag[] = [];
  for (const ref of advertisement.refs) {
    if (!ref.name.startsWith("refs/tags/") || ref.name.endsWith("^{}")) continue;
    tags.push({ ref, peeledOid: peeled.get(ref.name) ?? ref.oid });
  }
  return tags;
}

function snapshottedTagNames(snapshot: FetchPublicationToken): Set<string> {
  return new Set(snapshot.globalRefs.filter((ref) => ref.target !== null).map((ref) => ref.name));
}

export function eligibleAutoTags(
  repo: Repository,
  tags: readonly AdvertisedTag[],
  snapshot: FetchPublicationToken,
): AdvertisedTag[] {
  const local = snapshottedTagNames(snapshot);
  const present = repo.store.hasAll(tags.map((tag) => tag.peeledOid));
  return tags.filter((tag) => !local.has(tag.ref.name) && present.has(tag.peeledOid));
}

export function preflightAllTags(
  snapshot: FetchPublicationToken,
  tags: readonly AdvertisedTag[],
): void {
  if (tags.length === 0) return;
  const existing = new Map(snapshot.globalRefs.map((ref) => [ref.name, ref.target]));
  for (const tag of tags) {
    const target = existing.get(tag.ref.name);
    if (target !== undefined && target !== null && target !== tag.ref.oid) {
      throw new GitError("ETAGFAIL", `fetch would clobber existing tag ${tag.ref.name}`);
    }
  }
}

function readTagObjects(repo: Repository, oids: readonly string[]): Map<string, RawObject> {
  const objects = new Map<string, RawObject>();
  let pending = [...new Set(oids)];
  while (pending.length > 0) {
    const page = pending.slice(0, TAG_OBJECT_PAGE);
    const tail = pending.slice(TAG_OBJECT_PAGE);
    const info = repo.store.objectInfo(page);
    let selected = 0;
    let selectedBytes = 0;
    while (selected < info.length) {
      const entry = info[selected];
      const oid = page[selected];
      if (entry === undefined || oid === undefined || entry.oid !== oid) {
        throw new CorruptError("tag authentication metadata is incomplete");
      }
      if (selected > 0 && entry.size > PACK_BLOB_BATCH_TARGET_BYTES - selectedBytes) {
        break;
      }
      selectedBytes += entry.size;
      selected++;
    }
    const selectedOids = page.slice(0, selected);
    const batch = repo.readObjects(selectedOids, {
      budgetBytes: Math.max(1, selectedBytes),
    });
    if (batch.remaining.length > 0 || batch.objects.size !== selectedOids.length) {
      throw new CorruptError("tag authentication made no progress");
    }
    for (const [oid, object] of batch.objects) {
      if (hashObject(object.type, object.data) !== oid) {
        throw new CorruptError(`tag object ${oid} does not match its bytes`);
      }
      objects.set(oid, object);
    }
    pending = [...page.slice(selected), ...tail];
  }
  return objects;
}

interface TagPeelState {
  tag: AdvertisedTag;
  current: string;
  expectedType?: ObjectType;
  seen: Set<string>;
}

function objectTypes(repo: Repository, oids: readonly string[]): Map<string, ObjectType> {
  const types = new Map<string, ObjectType>();
  const unique = [...new Set(oids)];
  for (let offset = 0; offset < unique.length; offset += TAG_OBJECT_PAGE) {
    for (const info of repo.store.objectInfo(unique.slice(offset, offset + TAG_OBJECT_PAGE))) {
      types.set(info.oid, info.type);
    }
  }
  return types;
}

export function parseAuthenticatedTag(name: string, data: Uint8Array) {
  let headerEnd = -1;
  for (let index = 0; index + 1 < data.length; index++) {
    if (data[index] === 0x0a && data[index + 1] === 0x0a) {
      headerEnd = index;
      break;
    }
  }
  if (headerEnd < 0) throw new CorruptError(`tag ${name} has no header terminator`);
  let text: string;
  try {
    text = tagHeaderDecoder.decode(data.subarray(0, headerEnd));
  } catch {
    throw new CorruptError(`tag ${name} has malformed header text`);
  }
  let objects = 0;
  let types = 0;
  let names = 0;
  for (const line of text.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) throw new CorruptError(`tag ${name} has a malformed header`);
    const key = line.slice(0, space);
    if (key === "object") objects++;
    else if (key === "type") types++;
    else if (key === "tag") names++;
  }
  if (objects !== 1 || types !== 1 || names !== 1) {
    throw new CorruptError(`tag ${name} does not have exactly one object, type, and tag header`);
  }
  return parseTag(data);
}

/** Authenticate every annotated tag against the advertisement before publication. */
export function authenticateTags(repo: Repository, tags: readonly AdvertisedTag[]): void {
  const unique = new Map<string, AdvertisedTag>();
  for (const tag of tags) unique.set(tag.ref.name, tag);
  const required = [...unique.values()];
  const requiredOids: string[] = [];
  for (const tag of required) requiredOids.push(tag.ref.oid, tag.peeledOid);
  const held = repo.store.hasAll(new Set(requiredOids));
  for (const tag of required) {
    if (!held.has(tag.ref.oid) || !held.has(tag.peeledOid)) {
      throw new GitError("EFETCHFAIL", `fetch did not receive complete tag ${tag.ref.name}`);
    }
  }

  const rootTypes = objectTypes(
    repo,
    required.map((tag) => tag.ref.oid),
  );
  const pendingRoots: TagPeelState[] = [];
  for (const tag of required) {
    const rootType = rootTypes.get(tag.ref.oid);
    if (rootType === undefined) {
      throw new GitError("EFETCHFAIL", `fetch did not receive complete tag ${tag.ref.name}`);
    }
    if (rootType === "tag") {
      if (tag.ref.oid === tag.peeledOid) {
        throw new CorruptError(`annotated tag ${tag.ref.name} has no advertised peeled target`);
      }
      pendingRoots.push({ tag, current: tag.ref.oid, seen: new Set<string>() });
    } else if (tag.ref.oid !== tag.peeledOid) {
      throw new CorruptError(`tag ${tag.ref.name} has an invalid advertised peeled target`);
    }
  }
  let pending = pendingRoots;
  for (let hop = 0; hop < TAG_PEEL_HOPS && pending.length > 0; hop++) {
    const frontier = new Set(pending.map((state) => state.current));
    const heldFrontier = repo.store.hasAll(frontier);
    for (const state of pending) {
      if (!heldFrontier.has(state.current)) {
        throw new GitError(
          "EFETCHFAIL",
          `fetch did not receive complete tag ${state.tag.ref.name}`,
        );
      }
    }
    const objects = readTagObjects(repo, [...frontier]);
    const next: TagPeelState[] = [];
    for (const state of pending) {
      const object = objects.get(state.current);
      if (object === undefined) {
        throw new GitError(
          "EFETCHFAIL",
          `fetch did not receive complete tag ${state.tag.ref.name}`,
        );
      }
      if (state.expectedType !== undefined && object.type !== state.expectedType) {
        throw new CorruptError(`tag ${state.tag.ref.name} has a mismatched target type`);
      }
      if (object.type !== "tag") {
        if (state.current !== state.tag.peeledOid) {
          throw new CorruptError(`tag ${state.tag.ref.name} does not match its advertised target`);
        }
        continue;
      }
      if (state.seen.has(state.current)) {
        throw new CorruptError(`tag ${state.tag.ref.name} contains a cycle`);
      }
      state.seen.add(state.current);
      const parsed = parseAuthenticatedTag(state.tag.ref.name, object.data);
      next.push({
        tag: state.tag,
        current: parsed.object,
        expectedType: parsed.type,
        seen: state.seen,
      });
    }
    pending = next;
  }
  if (pending.length > 0) {
    const first = pending[0];
    if (first === undefined) throw new CorruptError("tag peel state is incomplete");
    throw new CorruptError(`tag ${first.tag.ref.name} exceeds ${TAG_PEEL_HOPS} peel hops`);
  }
}

/**
 * Authenticate every fetched ref before publication. A pack whose framing and
 * trailer validate can still omit a requested `want`, and no ref may name an
 * object the transfer did not deliver.
 */
export function authenticateFetchedCoverage(
  repo: Repository,
  coverage: readonly RemoteRef[],
  candidates: readonly string[],
): ReadonlyMap<string, ObjectType> {
  const held = repo.store.hasAll(new Set(candidates));
  for (const ref of coverage) {
    if (!held.has(ref.oid)) {
      throw new GitError("EFETCHFAIL", `fetch did not receive ${ref.name}`);
    }
  }
  const types = objectTypes(repo, candidates);
  for (const ref of coverage) {
    if (ref.name.startsWith("refs/heads/") && types.get(ref.oid) !== "commit") {
      throw new CorruptError(`fetched branch ${ref.name} does not point to a commit`);
    }
  }
  return types;
}
