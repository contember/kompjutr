import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError, ObjectNotFoundError } from "../../../common/errors.js";
import type { ObjectType } from "../../../common/objects.js";
import { expectSafeInteger, expectText } from "../../../common/rows.js";
import { MAX_PROMISED_BLOB_LOOKUP_OIDS } from "../../fetch/promisor.js";
import type { TreeObjectReader } from "../../trees/tree-closure.js";
import { iterateTreeDiffObjects, type WalkTreeDiffObject } from "../../trees/tree-walk.js";
import { canonicalPackEntrySql } from "../canonical.js";
import { isObjectType } from "../shared.js";

/** Reachability from the refs and checkout `HEAD`s a fetch began with (ADR-0029). */
export interface FetchReachability {
  /** The subset of `oids` reachable from those refs. */
  reached(oids: readonly string[]): ReadonlySet<string>;
}

/** A reference no pack of the operation resolves, with the one type it must have. */
export interface ExternalReference {
  oid: string;
  expected: ObjectType;
}

interface StoredObject {
  type: ObjectType | null;
  promised: boolean;
}

function requireLookupPage(oids: readonly string[]): void {
  if (oids.length > MAX_PROMISED_BLOB_LOOKUP_OIDS) {
    throw new GitError(
      "E2BIG",
      `stored object lookup exceeds ${MAX_PROMISED_BLOB_LOOKUP_OIDS} inputs`,
    );
  }
}

/** The readable type and promise state of each of `oids`; one bounded page per call. */
function readStoredObjects(
  db: SqlDatabase,
  repoId: number,
  oids: readonly string[],
): Map<string, StoredObject> {
  requireLookupPage(oids);
  const stored = new Map<string, StoredObject>();
  if (oids.length === 0) return stored;
  for (const row of db.iterate(
    `SELECT wanted.value AS oid,
            COALESCE(
              (SELECT loose.type FROM git_objects loose
                WHERE loose.repo_id = ? AND loose.oid = wanted.value),
              (SELECT packed.type FROM git_pack_entries packed
                WHERE packed.repo_id = ? AND (packed.pack_id, packed.offset) = (
                  ${canonicalPackEntrySql("packed.repo_id", "wanted.value")}
                ))
            ) AS type,
            EXISTS (
              SELECT 1 FROM git_promised_blobs promised
               WHERE promised.repo_id = ? AND promised.oid = wanted.value
            ) AS promised
       FROM json_each(?) wanted`,
    repoId,
    repoId,
    repoId,
    JSON.stringify(oids),
  )) {
    const oid = expectText(row.oid, "stored object id");
    const type = row.type === null ? null : expectText(row.type, "stored object type");
    if (type !== null && !isObjectType(type))
      throw new CorruptError("stored object type is invalid");
    const promised = expectSafeInteger(row.promised, 0, 1, "stored promise flag") === 1;
    stored.set(oid, { type, promised });
  }
  return stored;
}

function readCommitTrees(db: SqlDatabase, repoId: number, commits: readonly string[]): string[] {
  const trees: string[] = [];
  for (let start = 0; start < commits.length; start += MAX_PROMISED_BLOB_LOOKUP_OIDS) {
    for (const row of db.iterate(
      `SELECT commit_row.tree
         FROM json_each(?) wanted
         JOIN git_commits commit_row
           ON commit_row.repo_id = ? AND commit_row.oid = wanted.value`,
      JSON.stringify(commits.slice(start, start + MAX_PROMISED_BLOB_LOOKUP_OIDS)),
      repoId,
    )) {
      trees.push(expectText(row.tree, "commit tree oid"));
    }
  }
  return trees;
}

function requireType(oid: string, stored: StoredObject | undefined, expected: ObjectType): void {
  const type = stored?.type ?? null;
  if (type !== null && type !== expected) {
    throw new CorruptError(`fetched graph requires ${oid} to be a ${expected}`);
  }
}

/**
 * The non-fresh half of the per-pack check (ADR-0029). A commit or tag must be
 * reachable from the starting refs, a blob present or promised, and a tree
 * either inside the root-tree closure of a proven commit or present with a
 * closed closure. Closures are read through the tree walk.
 */
export class ExternalReferenceCheck {
  readonly #db: SqlDatabase;
  readonly #repoId: number;
  readonly #trees: TreeObjectReader;
  readonly #reachability: FetchReachability;
  readonly #filtered: boolean;
  readonly #reachable: string[] = [];
  readonly #commits: string[] = [];
  readonly #externalTrees: string[] = [];

  constructor(
    db: SqlDatabase,
    repoId: number,
    trees: TreeObjectReader,
    reachability: FetchReachability,
    filtered: boolean,
  ) {
    this.#db = db;
    this.#repoId = repoId;
    this.#trees = trees;
    this.#reachability = reachability;
    this.#filtered = filtered;
  }

  /** Check one page against the store; returns the blobs a filtered fetch promises. */
  add(page: readonly ExternalReference[]): string[] {
    const stored = readStoredObjects(
      this.#db,
      this.#repoId,
      page.map((reference) => reference.oid),
    );
    const promises: string[] = [];
    for (const { oid, expected } of page) {
      const object = stored.get(oid);
      requireType(oid, object, expected);
      const present = object !== undefined && object.type !== null;
      if (expected === "blob") {
        if (present || object?.promised === true) continue;
        if (!this.#filtered) throw new ObjectNotFoundError(oid);
        promises.push(oid);
        continue;
      }
      if (!present) throw new ObjectNotFoundError(oid);
      if (expected === "tree") {
        this.#externalTrees.push(oid);
        continue;
      }
      this.#reachable.push(oid);
      if (expected === "commit") this.#commits.push(oid);
    }
    return promises;
  }

  /** Prove the collected commits, tags and trees; run after every page was added. */
  finish(): void {
    const reached = this.#reachability.reached(this.#reachable);
    for (const oid of this.#reachable) {
      if (!reached.has(oid)) throw new ObjectNotFoundError(oid);
    }
    if (this.#externalTrees.length === 0) return;
    const verified = new Set<string>();
    for (const tree of this.#outsideProvenClosure()) {
      if (!verified.has(tree)) this.#requireClosure(tree, verified);
    }
  }

  /**
   * External trees that no proven commit's root tree reaches. Each later root
   * is diffed against the previous one: a subtree equal at the same path was
   * already seen.
   */
  #outsideProvenClosure(): Set<string> {
    const pending = new Set(this.#externalTrees);
    const roots = readCommitTrees(this.#db, this.#repoId, this.#commits);
    for (const root of roots) pending.delete(root);
    let previous: string | null = null;
    for (const root of roots) {
      if (pending.size === 0) break;
      for (const object of iterateTreeDiffObjects(
        this.#db,
        this.#repoId,
        this.#trees,
        previous,
        root,
      )) {
        if (object.type === "tree" && pending.delete(object.oid) && pending.size === 0) break;
      }
      previous = root;
    }
    return pending;
  }

  /**
   * Every subtree present and every blob present or promised; adds the
   * closure's trees to `verified`. The walk does not descend into a subtree
   * an earlier closure already verified.
   */
  #requireClosure(tree: string, verified: Set<string>): void {
    const trees: string[] = [tree];
    let page: WalkTreeDiffObject[] = [];
    const check = (): void => {
      const stored = readStoredObjects(
        this.#db,
        this.#repoId,
        page.map((object) => object.oid),
      );
      for (const { oid, type } of page) {
        const object = stored.get(oid);
        requireType(oid, object, type);
        const present = object !== undefined && object.type !== null;
        if (!present && !(type === "blob" && object?.promised === true)) {
          throw new ObjectNotFoundError(oid);
        }
      }
      page = [];
    };
    for (const object of iterateTreeDiffObjects(
      this.#db,
      this.#repoId,
      this.#trees,
      null,
      tree,
      verified,
    )) {
      page.push(object);
      if (object.type === "tree") trees.push(object.oid);
      if (page.length === MAX_PROMISED_BLOB_LOOKUP_OIDS) check();
    }
    check();
    for (const oid of trees) verified.add(oid);
  }
}
