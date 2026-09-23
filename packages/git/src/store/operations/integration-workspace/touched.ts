import {
  decodeRow,
  expectSafeInteger,
  expectText,
  object,
  oneOf,
  text,
} from "../../../common/rows.js";
import { JSON_BATCH_BYTES, utf8ByteLength } from "../../core/json-pages.js";
import { operationTouchedFromRow, persistedOperationTouched } from "../operation-journal-rows.js";
import type { OperationTouchedRow, PersistedOperationTouched } from "../operation-journal-types.js";
import type { MergeTouchedPath } from "../operations.js";
import type { MergePathPurpose } from "./descriptors.js";
import {
  decodeDescriptor,
  INTEGRATION_PAGE_ROWS,
  type IntegrationWorkspaceOwner,
  integrationJsonPages,
  isFinalKeysetPage,
} from "./storage.js";

export interface IntegrationTouchedShape {
  path: string;
  logicalPath: string;
  purpose: MergePathPurpose;
}

export class IntegrationTouched implements Iterable<MergeTouchedPath> {
  #nextOrdinal = 0;

  constructor(
    private readonly owner: IntegrationWorkspaceOwner,
    private readonly planId: number,
  ) {}

  get length(): number {
    const owner = this.owner;
    owner.requireActive();
    return expectSafeInteger(
      owner.db.scalar(
        `SELECT count(*) FROM git_integration_touched WHERE repo_id = ? AND workspace_id = ? AND plan_id = ?`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
      ),
      0,
    );
  }

  reserve(entries: Iterable<IntegrationTouchedShape>): void {
    const owner = this.owner;
    owner.requireActive();
    for (const page of integrationJsonPages(this.drafts(entries))) {
      owner.requireActive();
      owner.db.run(
        `INSERT INTO git_integration_touched
           (repo_id, workspace_id, plan_id, ordinal, path, logical_path, purpose)
         SELECT ?, ?, ?, json_extract(value, '$.ordinal'), json_extract(value, '$.path'),
           json_extract(value, '$.logicalPath'), json_extract(value, '$.purpose') FROM json_each(?) WHERE 1
         ON CONFLICT (repo_id, workspace_id, plan_id, path) DO NOTHING`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        page,
      );
    }
  }

  private *drafts(entries: Iterable<IntegrationTouchedShape>) {
    for (const entry of entries) {
      this.owner.requireActive();
      const shape = decodeDescriptor(
        object({
          path: text(),
          logicalPath: text(),
          purpose: oneOf(["primary", "current-relocation", "incoming-relocation"]),
        }),
        entry,
        false,
      );
      yield { ...shape, ordinal: this.#nextOrdinal++ };
    }
  }

  save(entries: Iterable<MergeTouchedPath>): void {
    const owner = this.owner;
    owner.requireActive();
    for (const page of integrationJsonPages(this.snapshots(entries))) {
      owner.requireActive();
      owner.db.run(
        `INSERT INTO git_integration_touched
           (repo_id, workspace_id, plan_id, ordinal, path, logical_path, purpose,
            index_stage, index_mode, index_oid, index_size, index_mtime, index_ino, index_rev,
            worktree_kind, worktree_mode, worktree_oid, worktree_revision)
         SELECT ?, ?, ?, json_extract(value, '$.ordinal'), json_extract(value, '$.path'),
           json_extract(value, '$.logicalPath'), json_extract(value, '$.purpose'),
           json_extract(value, '$.indexStage'), json_extract(value, '$.indexMode'),
           json_extract(value, '$.indexOid'), json_extract(value, '$.indexSize'),
           json_extract(value, '$.indexMtime'), json_extract(value, '$.indexIno'),
           json_extract(value, '$.indexRev'), json_extract(value, '$.worktreeKind'),
           json_extract(value, '$.worktreeMode'), json_extract(value, '$.worktreeOid'),
           json_extract(value, '$.worktreeRevision') FROM json_each(?) WHERE 1
         ON CONFLICT (repo_id, workspace_id, plan_id, path) DO UPDATE SET
           index_stage = excluded.index_stage, index_mode = excluded.index_mode,
           index_oid = excluded.index_oid, index_size = excluded.index_size,
           index_mtime = excluded.index_mtime, index_ino = excluded.index_ino,
           index_rev = excluded.index_rev, worktree_kind = excluded.worktree_kind,
           worktree_mode = excluded.worktree_mode, worktree_oid = excluded.worktree_oid,
           worktree_revision = excluded.worktree_revision`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        page,
      );
    }
  }

  private *snapshots(entries: Iterable<MergeTouchedPath>): Generator<PersistedOperationTouched> {
    for (const entry of entries) {
      this.owner.requireActive();
      yield persistedOperationTouched(entry, this.#nextOrdinal++);
    }
  }

  *shapes(): Generator<IntegrationTouchedShape> {
    for (const row of this.rows()) {
      const shape = decodeRow(row, {
        path: text(),
        logical_path: text(),
        purpose: oneOf(["primary", "current-relocation", "incoming-relocation"]),
      });
      yield { path: shape.path, logicalPath: shape.logical_path, purpose: shape.purpose };
    }
  }

  *[Symbol.iterator](): Generator<MergeTouchedPath> {
    for (const row of this.rows()) {
      yield operationTouchedFromRow(row);
    }
  }

  private *rows(): Generator<OperationTouchedRow> {
    const owner = this.owner;
    let after = "";
    while (true) {
      owner.requireActive();
      const page: OperationTouchedRow[] = [];
      let bytes = 0;
      let scanned = 0;
      let byteCapped = false;
      for (const row of owner.db.iterate(
        `SELECT ordinal, path, logical_path, purpose,
           index_stage, index_mode, index_oid, index_size, index_mtime, index_ino, index_rev,
           worktree_kind, worktree_mode, worktree_oid, worktree_revision
         FROM git_integration_touched WHERE repo_id = ? AND workspace_id = ? AND plan_id = ?
           AND path > ? COLLATE BINARY ORDER BY path COLLATE BINARY LIMIT ${INTEGRATION_PAGE_ROWS}`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        after,
      )) {
        scanned++;
        const size = utf8ByteLength(JSON.stringify(row));
        if (page.length > 0 && bytes + size > JSON_BATCH_BYTES) {
          byteCapped = true;
          break;
        }
        page.push({
          ordinal: row.ordinal,
          path: row.path,
          logical_path: row.logical_path,
          purpose: row.purpose,
          index_stage: row.index_stage,
          index_mode: row.index_mode,
          index_oid: row.index_oid,
          index_size: row.index_size,
          index_mtime: row.index_mtime,
          index_ino: row.index_ino,
          index_rev: row.index_rev,
          worktree_kind: row.worktree_kind,
          worktree_mode: row.worktree_mode,
          worktree_oid: row.worktree_oid,
          worktree_revision: row.worktree_revision,
        });
        bytes += size;
        after = expectText(row.path);
        if (bytes >= JSON_BATCH_BYTES) {
          byteCapped = true;
          break;
        }
      }
      if (page.length === 0) return;
      const final = isFinalKeysetPage(scanned, byteCapped);
      for (const row of page) {
        owner.requireActive();
        yield row;
      }
      if (final) return;
    }
  }
}
