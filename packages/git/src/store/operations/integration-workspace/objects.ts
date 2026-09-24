import type { BlobReadBatch, ObjectReadInfo } from "../../core/contracts.js";
import type { SharedRepoStore } from "../../repository/shared.js";
import { sharedRepoStoreMutations } from "../../repository/shared.js";
import type { WalkTreeEntry } from "../../trees/tree-walk.js";
import type { IntegrationWorkspaceOwner } from "./storage.js";

export interface IntegrationSource {
  objectInfo(oids: readonly string[]): IntegrationObjectInfo[];
  readBlobs(oids: readonly string[], options?: { budgetBytes?: number }): BlobReadBatch;
  walkTree(treeOid: string): Iterable<WalkTreeEntry>;
}

export type IntegrationObjectInfo = Pick<ObjectReadInfo, "oid" | "type" | "size">;

/**
 * Integration output is written as ordinary loose objects inside the
 * workspace transaction, so a fault rolls it back with everything else and an
 * unpublished result is left for maintenance to collect.
 */
export class IntegrationWorkspaceObjects implements IntegrationSource {
  constructor(
    private readonly owner: IntegrationWorkspaceOwner,
    private readonly ordinary: SharedRepoStore,
  ) {}

  write(type: "blob" | "tree", data: Uint8Array): string {
    this.owner.requireActive();
    // The streamed write keeps no copy in the object cache.
    return sharedRepoStoreMutations(this.ordinary).writeStreamOwned(type, data.length, () => [
      data,
    ]);
  }

  objectInfo(oids: readonly string[]): IntegrationObjectInfo[] {
    this.owner.requireActive();
    return this.ordinary.objectInfo(oids);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    this.owner.requireActive();
    return this.ordinary.readBlobs(oids, options);
  }

  walkTree(treeOid: string): Generator<WalkTreeEntry> {
    return this.owner.scoped(this.ordinary.walkTree(treeOid));
  }
}
