import { isOid } from "../../common/bytes.js";
import { CorruptError } from "../../common/errors.js";
import { MAX_PROMISED_BLOB_LOOKUP_OIDS } from "../../store/fetch/promisor.js";
import { listCheckoutsOwned } from "../../store/index.js";
import { MAX_BLOB_BATCH_OIDS } from "../../store/objects/objects.js";
import {
  readAcceptedPackTypes,
  readFreshObjectStore,
} from "../../store/pack/ingest/ingest-references-check.js";
import type { FetchReachability } from "../../store/pack/ingest/ingest-references-external.js";
import { readReachableAncestry } from "../../store/trees/commits.js";
import type { GitContext } from "../core/context.js";
import type { Repository } from "../repository/repository.js";
import { parseAuthenticatedTag } from "./network-tags.js";

// Seeds and pages are bound parameters; Durable Object SQLite refuses one above ~2 MB.
const SEED_PAGE = 4_096;
const TAG_BATCH_BYTES = 4 * 1024 * 1024;

/** What every pack of one fetch operation is checked against at ingest (ADR-0029). */
export interface FetchConnectivity {
  /** Read once, when the fetch begins; null when the store was fresh. */
  readonly reachability: RefReachability | null;
  readonly promisor?: { readonly remoteName: string; readonly url: string };
  readonly shallow: Set<string>;
  readonly unshallow: Set<string>;
  readonly acceptedPacks: number[];
}

function* pages<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}

/**
 * The objects reachable from the refs and every checkout `HEAD` as they stood
 * when a fetch began (ADR-0029). One commit walk serves the whole operation: it
 * stops once a query is answered and resumes from its frontier for the next.
 * Tag tips are peeled only when the commit walk alone does not answer.
 */
export class RefReachability implements FetchReachability {
  /** The object IDs the starting refs and checkout `HEAD`s named, current `HEAD` first. */
  readonly tips: readonly string[];
  readonly #repo: Repository;
  /** The tips, and the objects their tag chains name once peeled. */
  readonly #named: Set<string>;
  readonly #commits = new Set<string>();
  #frontier: string[];
  #peeled = false;

  constructor(repo: Repository, tips: Iterable<string>) {
    this.#repo = repo;
    this.#named = new Set(tips);
    this.tips = [...this.#named];
    this.#frontier = [...this.#named];
  }

  reached(oids: readonly string[]): Set<string> {
    const found = new Set<string>();
    // An absent object is never reachable, even when a ref names it; excluding it
    // also spares a walk to the root.
    const pending = this.#repo.store.hasAll(new Set(oids));
    for (const oid of pending) {
      if (this.#named.has(oid) || this.#commits.has(oid)) {
        pending.delete(oid);
        found.add(oid);
      }
    }
    this.#walk(pending, found);
    if (pending.size > 0 && !this.#peeled) {
      this.#peelTags();
      for (const oid of pending) {
        if (this.#named.has(oid)) {
          pending.delete(oid);
          found.add(oid);
        }
      }
      this.#walk(pending, found);
    }
    return found;
  }

  #walk(pending: Set<string>, found: Set<string>): void {
    const db = this.#repo.store.db;
    const repoId = this.#repo.store.repoId;
    while (pending.size > 0 && this.#frontier.length > 0) {
      const seeds = this.#frontier.splice(0, SEED_PAGE).filter((oid) => !this.#commits.has(oid));
      if (seeds.length === 0) continue;
      // Seeds and parents not yet visited; they become the frontier if the walk stops early.
      const unvisited = new Set(seeds);
      let stopped = false;
      for (const commit of readReachableAncestry(db, repoId, seeds)) {
        unvisited.delete(commit.oid);
        if (this.#commits.has(commit.oid)) continue;
        this.#commits.add(commit.oid);
        for (const parent of commit.parents) {
          if (!this.#commits.has(parent)) unvisited.add(parent);
        }
        if (pending.delete(commit.oid)) {
          found.add(commit.oid);
          if (pending.size === 0) {
            stopped = true;
            break;
          }
        }
      }
      if (stopped) this.#frontier.push(...unvisited);
    }
  }

  /** Name every object a tip's tag chain reaches; peeled commits seed the walk. */
  #peelTags(): void {
    this.#peeled = true;
    let candidates = [...this.#named].filter((oid) => !this.#commits.has(oid));
    while (candidates.length > 0) {
      const sizes = new Map<string, number>();
      const present = [...this.#repo.store.hasAll(candidates)];
      for (const page of pages(present, MAX_BLOB_BATCH_OIDS)) {
        for (const info of this.#repo.store.objectInfo(page)) {
          if (info.type === "tag") sizes.set(info.oid, info.size);
        }
      }
      candidates = [];
      let pending = [...sizes.keys()];
      while (pending.length > 0) {
        const first = pending[0];
        const firstSize = first === undefined ? undefined : sizes.get(first);
        if (firstSize === undefined) throw new CorruptError("tag metadata is incomplete");
        const batch = this.#repo.readObjects(pending, {
          budgetBytes: Math.max(TAG_BATCH_BYTES, firstSize),
        });
        if (batch.objects.size === 0) throw new CorruptError("tag peel made no progress");
        for (const [oid, object] of batch.objects) {
          const tag = parseAuthenticatedTag(oid, object.data);
          if (this.#named.has(tag.object)) continue;
          this.#named.add(tag.object);
          if (tag.type === "commit") this.#frontier.push(tag.object);
          else if (tag.type === "tag") candidates.push(tag.object);
        }
        pending = batch.remaining;
      }
    }
  }
}

/** Every object ID a ref or a checkout `HEAD` names directly, current `HEAD` first. */
function startingTips(context: GitContext, repo: Repository): string[] {
  const head = repo.head().oid;
  const tips = head === null ? [] : [head];
  for (const ref of repo.store.listRefs()) {
    if (isOid(ref.target)) tips.push(ref.target);
  }
  for (const checkout of listCheckoutsOwned(context.database, repo.store.repoId)) {
    if (isOid(checkout.head)) tips.push(checkout.head);
  }
  return tips;
}

export function beginFetchConnectivity(
  context: GitContext,
  repo: Repository,
  promisor: { remoteName: string; url: string } | undefined,
): FetchConnectivity {
  const fresh = readFreshObjectStore(repo.store.db, repo.store.repoId);
  return {
    reachability: fresh ? null : new RefReachability(repo, startingTips(context, repo)),
    ...(promisor === undefined ? {} : { promisor }),
    shallow: new Set(),
    unshallow: new Set(),
    acceptedPacks: [],
  };
}

/**
 * The subset of `oids` a fetch may build on: delivered by a pack it accepted,
 * or reachable from the refs it began with. Presence alone proves nothing.
 */
export function connectedObjects(
  repo: Repository,
  connectivity: FetchConnectivity,
  oids: readonly string[],
): Set<string> {
  const connected = new Set<string>();
  const outside: string[] = [];
  for (const page of pages([...new Set(oids)], MAX_PROMISED_BLOB_LOOKUP_OIDS)) {
    const delivered = readAcceptedPackTypes(
      repo.store.db,
      repo.store.repoId,
      connectivity.acceptedPacks,
      page,
    );
    for (const oid of page) {
      if (delivered.has(oid)) connected.add(oid);
      else outside.push(oid);
    }
  }
  if (connectivity.reachability !== null && outside.length > 0) {
    for (const oid of connectivity.reachability.reached(outside)) connected.add(oid);
  }
  return connected;
}
