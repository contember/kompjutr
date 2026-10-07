import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError, ObjectNotFoundError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import { expectSafeInteger, expectText } from "../../../common/rows.js";
import { MAX_PROMISED_BLOB_LOOKUP_OIDS, PromisorTable } from "../../fetch/promisor.js";
import { ShallowTable } from "../../refs/shallow.js";
import { isObjectType } from "../shared.js";
import { PackReferenceCollector, type UnresolvedReference } from "./ingest-references.js";
import {
  type ExternalReference,
  ExternalReferenceCheck,
  type FetchReachability,
} from "./ingest-references-external.js";

/** What a fetch tells pack ingest so the pack publishes only when its references resolve. */
export interface PackConnectivityOptions {
  /**
   * Reachability from the refs the fetch began with; null when the store then
   * held no loose object, complete pack, or promise, so nothing outside the
   * fetch's packs resolves.
   */
  readonly reachability: FetchReachability | null;
  /** A filtered fetch promises the blobs its packs reference but do not deliver. */
  readonly promisor?: { readonly remoteName: string; readonly url: string };
  /** The operation's shallow response so far, applied over the stored boundary. */
  readonly shallow: readonly string[];
  readonly unshallow: readonly string[];
  /** Packs this fetch operation already published; references may resolve into them. */
  readonly acceptedPacks: readonly number[];
}

/** Whether the repository holds no loose object, complete pack, or promise. */
export function readFreshObjectStore(db: SqlDatabase, repoId: number): boolean {
  const fresh = db.scalar<unknown>(
    `SELECT NOT EXISTS (SELECT 1 FROM git_objects WHERE repo_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM git_pack_meta WHERE repo_id = ? AND state = 'complete'
        )
        AND NOT EXISTS (SELECT 1 FROM git_promised_blobs WHERE repo_id = ?)`,
    repoId,
    repoId,
    repoId,
  );
  return expectSafeInteger(fresh, 0, 1, "fresh object store flag") === 1;
}

/** The types `oids` have in `packIds`; one bounded page of OIDs per call. */
export function readAcceptedPackTypes(
  db: SqlDatabase,
  repoId: number,
  packIds: readonly number[],
  oids: readonly string[],
): Map<string, Set<ObjectType>> {
  const types = new Map<string, Set<ObjectType>>();
  if (packIds.length === 0 || oids.length === 0) return types;
  if (oids.length > MAX_PROMISED_BLOB_LOOKUP_OIDS) {
    throw new GitError(
      "E2BIG",
      `accepted pack lookup exceeds ${MAX_PROMISED_BLOB_LOOKUP_OIDS} inputs`,
    );
  }
  for (const row of db.iterate(
    `SELECT entry.oid, entry.type
       FROM json_each(?) wanted
       JOIN git_pack_entries entry ON entry.repo_id = ? AND entry.oid = wanted.value
      WHERE entry.pack_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(oids),
    repoId,
    JSON.stringify(packIds),
  )) {
    const oid = expectText(row.oid, "accepted pack object id");
    const type = expectText(row.type, "accepted pack object type");
    if (!isObjectType(type)) throw new CorruptError("accepted pack object type is invalid");
    const known = types.get(oid) ?? new Set<ObjectType>();
    known.add(type);
    types.set(oid, known);
  }
  return types;
}

function readShallowRevision(db: SqlDatabase, repoId: number): number {
  return expectSafeInteger(
    db.scalar<unknown>("SELECT shallow_revision FROM git_repositories WHERE id = ?", repoId),
    0,
    Number.MAX_SAFE_INTEGER,
    "stored shallow revision",
  );
}

/**
 * The per-pack connectivity check of ADR-0029. The shallow boundary is read
 * when ingest starts and must be unchanged at publication, so boundary commits
 * can skip their parents while the pack streams.
 */
export class PackConnectivityCheck {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #options: PackConnectivityOptions;
  readonly #shallowRevision: number;
  readonly #boundary: Set<string>;
  #references: PackReferenceCollector | null = null;

  constructor(db: SqlDatabase, repoId: number, options: PackConnectivityOptions) {
    this.#db = db;
    this.#repoId = repoId;
    this.#options = options;
    this.#shallowRevision = readShallowRevision(db, repoId);
    this.#boundary = new ShallowTable(db, repoId).read();
    for (const oid of options.unshallow) this.#boundary.delete(oid);
    for (const oid of options.shallow) this.#boundary.add(oid);
  }

  /** The collector for a pack whose header declares `objectCount` objects. */
  collector(objectCount: number): PackReferenceCollector {
    if (this.#references !== null) {
      throw new CorruptError("pack connectivity check already started");
    }
    this.#references = new PackReferenceCollector(objectCount, this.#boundary);
    return this.#references;
  }

  /** Run inside the publication transaction; a failure leaves the pack unpublished. */
  publish(): void {
    const references = this.#references;
    if (references === null) throw new CorruptError("pack connectivity check has no collector");
    if (readShallowRevision(this.#db, this.#repoId) !== this.#shallowRevision) {
      throw new GitError("ESTALE", "shallow boundary changed during pack ingest");
    }
    references.requireTypes();
    const promisor = this.#options.promisor;
    const promises = new PromisorTable(this.#db, this.#repoId);
    if (promisor !== undefined) promises.register(promisor.remoteName, promisor.url);
    const reachability = this.#options.reachability;
    const external =
      reachability === null
        ? null
        : new ExternalReferenceCheck(this.#db, this.#repoId, reachability, promisor !== undefined);
    let page: UnresolvedReference[] = [];
    const flush = (): void => {
      const unresolved = this.#resolveAccepted(page);
      const blobs = external === null ? this.#resolveFresh(unresolved) : external.add(unresolved);
      if (promisor !== undefined) promises.addUnresolvedBlobs(promisor.remoteName, blobs);
      page = [];
    };
    for (const reference of references.unresolved()) {
      page.push(reference);
      if (page.length === MAX_PROMISED_BLOB_LOOKUP_OIDS) flush();
    }
    if (page.length > 0) flush();
    external?.finish();
  }

  /** Resolve one page against the accepted packs; returns the references left outside them. */
  #resolveAccepted(page: readonly UnresolvedReference[]): ExternalReference[] {
    const accepted = readAcceptedPackTypes(
      this.#db,
      this.#repoId,
      this.#options.acceptedPacks,
      page.map((reference) => reference.oid),
    );
    const external: ExternalReference[] = [];
    for (const reference of page) {
      // `requireTypes` leaves at most one expected type on an unresolved reference.
      const expected = reference.expected[0];
      if (expected === undefined) continue;
      const types = accepted.get(reference.oid);
      if (types === undefined) {
        external.push({ oid: reference.oid, expected });
      } else if (!types.has(expected)) {
        throw new CorruptError(`fetched graph requires ${reference.oid} to be a ${expected}`);
      }
    }
    return external;
  }

  /** A fresh store resolves nothing outside the fetch; returns the blobs a filtered fetch promises. */
  #resolveFresh(external: readonly ExternalReference[]): string[] {
    const blobs: string[] = [];
    for (const { oid, expected } of external) {
      if (expected !== "blob" || this.#options.promisor === undefined) {
        throw new ObjectNotFoundError(oid);
      }
      blobs.push(oid);
    }
    return blobs;
  }
}
