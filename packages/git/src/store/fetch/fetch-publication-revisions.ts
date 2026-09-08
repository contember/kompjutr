import type { SqlDatabase } from "@kompjutr/sqlite";
import { CorruptError, GitError } from "../../common/errors.js";
import { expectSafeInteger, expectText } from "../../common/rows.js";
import { jsonPages } from "../core/json-pages.js";
import type { RefMutationRevisionState, RefMutationRevisions } from "../refs/refs.js";
import { MAX_TRACKING_REF_REVISIONS } from "../schema/schema.js";
import { MAX_FETCH_NAMESPACES, requireFetchGeneration } from "./fetch-publication-state.js";

export class FetchPublicationRevisions implements RefMutationRevisions {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

  readTrackingRefRevision(refName: string): number | null {
    const revision = this.db.scalar<unknown>(
      `SELECT revision FROM git_tracking_ref_revisions
        WHERE repo_id = ? AND ref_name = ?`,
      this.repoId,
      refName,
    );
    return revision === undefined
      ? null
      : expectSafeInteger(revision, 0, Number.MAX_SAFE_INTEGER, "stored tracking ref revision");
  }

  #trackingRefRevisionCount(): number {
    const stored = this.db.scalar<unknown>(
      `SELECT count(*) FROM (
         SELECT 1 FROM git_tracking_ref_revisions
          WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
       )`,
      this.repoId,
    );
    return expectSafeInteger(stored, 0, MAX_TRACKING_REF_REVISIONS + 1, "tracking revision count");
  }

  ensureTrackingRefRevision(refName: string): number {
    const count = this.#trackingRefRevisionCount();
    const existing = this.readTrackingRefRevision(refName);
    if (existing !== null) return existing;
    if (count >= MAX_TRACKING_REF_REVISIONS) {
      throw new GitError("E2BIG", "repository tracking revision count exceeds 100,000");
    }
    this.db.run(
      `INSERT INTO git_tracking_ref_revisions (repo_id, ref_name, revision)
       SELECT ?, ?, 0 WHERE EXISTS (SELECT 1 FROM git_repositories WHERE id = ?)`,
      this.repoId,
      refName,
      this.repoId,
    );
    const created = this.readTrackingRefRevision(refName);
    if (created !== 0) throw new CorruptError("tracking revision creation failed");
    return created;
  }

  advanceTrackingRefObservations(trackingPrefix: string, count: number): void {
    if (count === 0) return;
    const matched = expectSafeInteger(
      this.db.scalar<unknown>(
        `SELECT count(*) FROM git_tracking_ref_revisions
        WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?`,
        this.repoId,
        trackingPrefix,
        trackingPrefix,
      ),
      0,
      count,
      "tracking observation count",
    );
    if (matched === 0) return;
    this.db.run(
      `UPDATE git_tracking_ref_revisions SET revision = revision + 1
        WHERE repo_id = ? AND substr(ref_name, 1, length(?)) = ?
          AND revision < ${Number.MAX_SAFE_INTEGER}`,
      this.repoId,
      trackingPrefix,
      trackingPrefix,
    );
    const changed = expectSafeInteger(this.db.scalar<unknown>("SELECT changes()"), 0, matched);
    if (changed !== matched) throw new GitError("E2BIG", "tracking ref revision is exhausted");
  }

  bumpTrackingRefRevisions(changedNames: ReadonlySet<string>): void {
    if (changedNames.size === 0) return;
    for (const page of jsonPages(changedNames, "tracking ref revision lookup")) {
      const affected = expectSafeInteger(
        this.db.scalar<unknown>(
          `SELECT count(*) FROM git_tracking_ref_revisions
          WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))`,
          this.repoId,
          page,
        ),
        0,
      );
      if (affected === 0) continue;
      this.db.run(
        `UPDATE git_tracking_ref_revisions SET revision = revision + 1
          WHERE repo_id = ? AND ref_name IN (SELECT value FROM json_each(?))
            AND revision < ${Number.MAX_SAFE_INTEGER}`,
        this.repoId,
        page,
      );
      const changed = expectSafeInteger(this.db.scalar<unknown>("SELECT changes()"), 0, affected);
      if (changed !== affected) throw new GitError("E2BIG", "tracking ref revision is exhausted");
    }
  }

  readRefMutationRevisionState(): RefMutationRevisionState {
    const state = this.db.one<{
      tracking_ref_revision_rows: unknown;
      fetch_generation: unknown;
      fetch_namespace_present: unknown;
    }>(
      `SELECT repository.fetch_generation,
              EXISTS(
                SELECT 1 FROM git_fetch_namespaces namespace
                 WHERE namespace.repo_id = ? LIMIT 1
              ) AS fetch_namespace_present,
              (SELECT count(*) FROM (
                 SELECT 1 FROM git_tracking_ref_revisions
                  WHERE repo_id = ? LIMIT ${MAX_TRACKING_REF_REVISIONS + 1}
               )) AS tracking_ref_revision_rows
         FROM git_repositories repository WHERE repository.id = ?`,
      this.repoId,
      this.repoId,
      this.repoId,
    );
    if (state === undefined) throw new CorruptError("repository is missing its reflog state");
    const trackingRefRevisionCount = requireFetchGeneration(
      state.tracking_ref_revision_rows,
      "stored tracking ref revision count",
      0,
    );
    if (trackingRefRevisionCount > MAX_TRACKING_REF_REVISIONS) {
      throw new CorruptError("tracking ref revision count exceeds its bound");
    }
    const fetchGeneration = requireFetchGeneration(
      state.fetch_generation,
      "stored fetch generation",
      0,
    );
    const fetchNamespacePresent =
      state.fetch_namespace_present === 1
        ? true
        : state.fetch_namespace_present === 0
          ? false
          : null;
    if (
      fetchNamespacePresent === null ||
      (fetchGeneration === 0) !== (fetchNamespacePresent === false)
    ) {
      throw new CorruptError("fetch generation and namespace state disagree");
    }
    return { trackingRefRevisionCount, fetchNamespacePresent };
  }

  readFetchNamespaces(): {
    trackingPrefix: string;
    latestGeneration: number;
    revision: number;
  }[] {
    const namespaces: {
      trackingPrefix: string;
      latestGeneration: number;
      revision: number;
    }[] = [];
    for (const row of this.db.iterate(
      `SELECT tracking_prefix, latest_generation, revision
           FROM git_fetch_namespaces WHERE repo_id = ? ORDER BY tracking_prefix
           LIMIT ${MAX_FETCH_NAMESPACES + 1}`,
      this.repoId,
    )) {
      if (namespaces.length >= MAX_FETCH_NAMESPACES) {
        throw new GitError("E2BIG", "repository fetch namespace count exceeds 1,024");
      }
      namespaces.push({
        trackingPrefix: expectText(row.tracking_prefix, "stored fetch tracking prefix"),
        latestGeneration: expectSafeInteger(
          row.latest_generation,
          1,
          Number.MAX_SAFE_INTEGER,
          "stored fetch namespace generation",
        ),
        revision: expectSafeInteger(
          row.revision,
          0,
          Number.MAX_SAFE_INTEGER,
          "stored fetch namespace revision",
        ),
      });
    }
    return namespaces;
  }

  bumpFetchNamespaceRevisions(changedNames: ReadonlySet<string>): void {
    if (changedNames.size === 0) return;
    const affected: string[] = [];
    for (const namespace of this.readFetchNamespaces()) {
      let changed = false;
      for (const name of changedNames) {
        if (name.startsWith(namespace.trackingPrefix)) {
          changed = true;
          break;
        }
      }
      if (!changed) continue;
      if (namespace.revision === Number.MAX_SAFE_INTEGER) {
        throw new GitError("E2BIG", "fetch namespace revision is exhausted");
      }
      affected.push(namespace.trackingPrefix);
    }
    for (const page of jsonPages(affected, "fetch namespace revision")) {
      this.db.run(
        `UPDATE git_fetch_namespaces SET revision = revision + 1
          WHERE repo_id = ? AND tracking_prefix IN (SELECT value FROM json_each(?))`,
        this.repoId,
        page,
      );
    }
  }
}
