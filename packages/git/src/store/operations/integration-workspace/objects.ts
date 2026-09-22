import { CorruptError, GitError } from "../../../common/errors.js";
import { hashObject, MAX_OBJECT_BYTES } from "../../../common/objects.js";
import { decodeRow, expectBlob, int, oneOf, text } from "../../../common/rows.js";
import { isTreeMode, parseTreeStream } from "../../../common/trees.js";
import type { BlobReadBatch, ObjectReadInfo } from "../../core/contracts.js";
import { OBJECT_CHUNK } from "../../objects/objects-shared.js";
import type { SharedRepoStore } from "../../repository/shared.js";
import { sharedRepoStoreMutations } from "../../repository/shared.js";
import type { WalkTreeEntry } from "../../trees/tree-walk.js";
import { type IntegrationWorkspaceOwner, integrationJsonPages } from "./storage.js";

export interface IntegrationSource {
  objectInfo(oids: readonly string[]): IntegrationObjectInfo[];
  readBlobs(oids: readonly string[], options?: { budgetBytes?: number }): BlobReadBatch;
  walkTree(treeOid: string): Iterable<WalkTreeEntry>;
}

export type IntegrationObjectInfo = Pick<ObjectReadInfo, "oid" | "type" | "size">;

export class IntegrationWorkspaceObjects implements IntegrationSource {
  constructor(
    private readonly owner: IntegrationWorkspaceOwner,
    private readonly ordinary: SharedRepoStore,
  ) {}

  write(type: "blob" | "tree", data: Uint8Array): string {
    const owner = this.owner;
    owner.requireActive();
    if (data.length > MAX_OBJECT_BYTES)
      throw new GitError("E2BIG", "integration object is too large");
    const oid = hashObject(type, data);
    if (this.info(oid) !== null) return oid;
    owner.db.run(
      `INSERT INTO git_integration_objects (repo_id, workspace_id, oid, type, size) VALUES (?, ?, ?, ?, ?)`,
      owner.repoId,
      owner.workspaceId,
      oid,
      type,
      data.length,
    );
    for (let offset = 0, seq = 0; offset < data.length; offset += OBJECT_CHUNK, seq++) {
      owner.db.run(
        `INSERT INTO git_integration_object_chunks (repo_id, workspace_id, oid, seq, data) VALUES (?, ?, ?, ?, ?)`,
        owner.repoId,
        owner.workspaceId,
        oid,
        seq,
        data.subarray(offset, offset + OBJECT_CHUNK),
      );
    }
    if (type === "tree") {
      const edges = function* () {
        for (const parsed of parseTreeStream([data]))
          yield { ordinal: parsed.ordinal, ...parsed.entry };
      };
      for (const page of integrationJsonPages(edges())) {
        owner.db.run(
          `INSERT INTO git_integration_tree_entries (repo_id, workspace_id, tree_oid, ordinal, name, mode, child_oid)
           SELECT ?, ?, ?, json_extract(value, '$.ordinal'), json_extract(value, '$.name'),
             json_extract(value, '$.mode'), json_extract(value, '$.oid') FROM json_each(?)`,
          owner.repoId,
          owner.workspaceId,
          oid,
          page,
        );
      }
    }
    return oid;
  }

  info(oid: string): IntegrationObjectInfo | null {
    const owner = this.owner;
    owner.requireActive();
    const row = owner.db.one(
      `SELECT oid, type, size FROM git_integration_objects WHERE repo_id = ? AND workspace_id = ? AND oid = ?`,
      owner.repoId,
      owner.workspaceId,
      oid,
    );
    return row === undefined
      ? null
      : decodeRow(row, { oid: text(), type: oneOf(["blob", "tree"]), size: int(0) });
  }

  objectInfo(oids: readonly string[]): IntegrationObjectInfo[] {
    this.owner.requireActive();
    const scoped = this.scopedInfo(oids);
    for (const info of this.ordinary.objectInfo(oids.filter((oid) => !scoped.has(oid))))
      scoped.set(info.oid, info);
    return oids.map((oid) => {
      const info = scoped.get(oid);
      if (info === undefined) throw new CorruptError(`integration object ${oid} is missing`);
      return info;
    });
  }

  private scopedInfo(oids: readonly string[]): Map<string, IntegrationObjectInfo> {
    const scoped = new Map<string, IntegrationObjectInfo>();
    for (const page of integrationJsonPages(oids)) {
      for (const row of this.owner.db.iterate(
        `SELECT oid, type, size FROM git_integration_objects
         WHERE repo_id = ? AND workspace_id = ? AND oid IN (SELECT value FROM json_each(?))`,
        this.owner.repoId,
        this.owner.workspaceId,
        page,
      )) {
        const info = decodeRow(row, { oid: text(), type: oneOf(["blob", "tree"]), size: int(0) });
        scoped.set(info.oid, info);
      }
    }
    return scoped;
  }

  *chunks(oid: string): Generator<Uint8Array> {
    const owner = this.owner;
    owner.requireActive();
    for (const row of owner.scoped(
      owner.db.iterate(
        `SELECT data FROM git_integration_object_chunks WHERE repo_id = ? AND workspace_id = ? AND oid = ? ORDER BY seq`,
        owner.repoId,
        owner.workspaceId,
        oid,
      ),
    ))
      yield expectBlob(row.data);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    this.owner.requireActive();
    const budget = options.budgetBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(budget) || budget < 1)
      throw new GitError("EINVAL", "invalid integration blob read budget");
    const unique = [...new Set(oids)];
    const infos = this.objectInfo(unique);
    let bytes = 0;
    let count = 0;
    for (const info of infos) {
      if (info.type !== "blob")
        throw new CorruptError(`integration object ${info.oid} is not a blob`);
      if (count > 0 && info.size > budget - bytes) break;
      bytes += info.size;
      count++;
    }
    const selected = unique.slice(0, count);
    const blobs = new Map<string, Uint8Array>();
    const ordinary: string[] = [];
    const scoped = this.scopedInfo(selected);
    for (const oid of selected) {
      const info = scoped.get(oid);
      if (info === undefined) {
        ordinary.push(oid);
        continue;
      }
      const data = new Uint8Array(info.size);
      let offset = 0;
      for (const chunk of this.chunks(oid)) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      blobs.set(oid, data);
    }
    if (ordinary.length > 0) {
      const batch = this.ordinary.readBlobs(ordinary, { budgetBytes: Math.max(1, bytes) });
      for (const [oid, data] of batch.blobs) blobs.set(oid, data);
    }
    const ordered = new Map<string, Uint8Array>();
    let returnedBytes = 0;
    for (const oid of selected) {
      const data = blobs.get(oid);
      if (data === undefined) break;
      ordered.set(oid, data);
      returnedBytes += data.length;
    }
    if (selected.length > 0 && ordered.size === 0)
      throw new CorruptError("integration blob read made no progress");
    return { blobs: ordered, bytes: returnedBytes, remaining: unique.slice(ordered.size) };
  }

  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    const owner = this.owner;
    owner.requireActive();
    const root = this.info(treeOid);
    if (root === null) {
      yield* owner.scoped(this.ordinary.walkTree(treeOid));
      return;
    }
    if (root.type !== "tree") throw new CorruptError(`${treeOid} is a ${root.type}, not a tree`);
    const pending: { prefix: string; entries: Iterator<WalkTreeEntry> }[] = [];
    const edges = (oid: string): Iterable<WalkTreeEntry> => this.edges(oid);
    pending.push({ prefix: "", entries: edges(treeOid)[Symbol.iterator]() });
    try {
      while (pending.length > 0) {
        owner.requireActive();
        const frame = pending[pending.length - 1]!;
        const next = frame.entries.next();
        if (next.done) {
          pending.pop();
          continue;
        }
        const entry = next.value;
        const path = frame.prefix + entry.path;
        if (isTreeMode(entry.mode)) {
          if (this.info(entry.oid) === null) {
            for (const leaf of owner.scoped(this.ordinary.walkTree(entry.oid)))
              yield { ...leaf, path: `${path}/${leaf.path}` };
          } else pending.push({ prefix: `${path}/`, entries: edges(entry.oid)[Symbol.iterator]() });
        } else yield { ...entry, path };
      }
    } finally {
      for (const frame of pending) frame.entries.return?.();
    }
  }

  private *edges(oid: string): Generator<WalkTreeEntry> {
    const owner = this.owner;
    for (const row of owner.scoped(
      owner.db.iterate(
        `SELECT name AS path, mode, child_oid AS oid FROM git_integration_tree_entries
       WHERE repo_id = ? AND workspace_id = ? AND tree_oid = ? ORDER BY ordinal`,
        owner.repoId,
        owner.workspaceId,
        oid,
      ),
    ))
      yield decodeRow(row, { path: text(), mode: text(), oid: text() });
  }

  adopt(oid: string): void {
    this.adoptMany([oid]);
  }

  adoptMany(oids: Iterable<string>): void {
    const owner = this.owner;
    owner.requireActive();
    const writer = sharedRepoStoreMutations(this.ordinary);
    for (const page of integrationJsonPages(oids)) {
      for (const row of owner.scoped(
        owner.db.iterate(
          `WITH RECURSIVE reachable(oid) AS (
         SELECT value FROM json_each(?) UNION
         SELECT e.child_oid FROM git_integration_tree_entries e JOIN reachable r ON e.tree_oid = r.oid
          WHERE e.repo_id = ? AND e.workspace_id = ? AND e.mode != '160000'
       ) SELECT o.oid, o.type, o.size FROM reachable r JOIN git_integration_objects o ON o.oid = r.oid
         WHERE o.repo_id = ? AND o.workspace_id = ?`,
          page,
          owner.repoId,
          owner.workspaceId,
          owner.repoId,
          owner.workspaceId,
        ),
      )) {
        const object = decodeRow(row, { oid: text(), type: oneOf(["blob", "tree"]), size: int(0) });
        writer.writeStreamOwned(object.type, object.size, () => this.chunks(object.oid));
      }
    }
  }
}
