import type { ObjectType, RawObject } from "../../common/objects.js";
import type {
  BlobIdMapping,
  BlobReadBatch,
  ObjectBatch,
  ObjectBatchOptions,
  ObjectReadBatch,
  ObjectReadInfo,
  OwnedObjectBatch,
  PromisedBlob,
  PromisorRemote,
} from "../core/contracts.js";
import { withGitMutationGuard } from "../core/mutation-guard.js";
import type { ObjectTable } from "../objects/objects.js";
import {
  iterateTree,
  iterateTreeDiff,
  iterateTreeDiffObjects,
  type WalkTreeDiffEntry,
  type WalkTreeDiffObject,
  type WalkTreeEntry,
} from "../trees/tree-walk.js";
import { SharedRepoCore } from "./shared-core.js";

/** Object, blob-ID, promisor, and tree-walk capabilities of a shared store. */
export abstract class SharedRepoObjectStore extends SharedRepoCore {
  lookupBlobIds(contentIds: Iterable<Uint8Array>): Map<string, string> {
    return this.blobIdTable().lookup(contentIds);
  }

  blobIdMismatches(expected: Iterable<BlobIdMapping>): Map<number, string | null> {
    return this.blobIdTable().mismatches(expected);
  }

  upsertBlobIds(mappings: Iterable<BlobIdMapping>): void {
    withGitMutationGuard(this.db, () => this.upsertBlobIdsOwned(mappings));
  }

  protected upsertBlobIdsOwned(mappings: Iterable<BlobIdMapping>): void {
    this.blobIdTable().upsert(mappings);
  }

  has(oid: string): boolean {
    return this.requireObjectTable().has(oid);
  }

  hasAll(oids: Iterable<string>): Set<string> {
    return this.requireObjectTable().hasAll(oids);
  }

  missing(oids: Iterable<string>): string[] {
    return this.requireObjectTable().missing(oids);
  }

  registerPromisorRemote(remoteName: string, url: string): PromisorRemote {
    return withGitMutationGuard(this.db, () => this.registerPromisorRemoteOwned(remoteName, url));
  }

  protected registerPromisorRemoteOwned(remoteName: string, url: string): PromisorRemote {
    return this.promisorTable().register(remoteName, url);
  }

  readPromisorRemote(remoteName: string): PromisorRemote | null {
    return this.promisorTable().read(remoteName);
  }

  addPromisedBlobs(remoteName: string, oids: Iterable<string>): void {
    withGitMutationGuard(this.db, () => this.addPromisedBlobsOwned(remoteName, oids));
  }

  protected addPromisedBlobsOwned(remoteName: string, oids: Iterable<string>): void {
    this.promisorTable().addBlobs(remoteName, oids);
  }

  addPromisedBlobsFromPackTrees(remoteName: string, packId: number): void {
    withGitMutationGuard(this.db, () =>
      this.addPromisedBlobsFromPackTreesOwned(remoteName, packId),
    );
  }

  protected addPromisedBlobsFromPackTreesOwned(remoteName: string, packId: number): void {
    this.promisorTable().addBlobsFromPackTrees(remoteName, packId);
  }

  promisedMissing(oids: readonly string[]): string[] {
    return this.promisorTable().promisedMissing(oids);
  }

  promisedMissingDetails(oids: readonly string[]): PromisedBlob[] {
    return this.promisorTable().promisedMissingDetails(oids);
  }

  promisedBlobCount(): number {
    return this.promisorTable().count();
  }

  *iteratePromisedBlobs(): Generator<PromisedBlob> {
    yield* this.promisorTable().iterate();
  }

  typeAndSize(oid: string): { type: ObjectType; size: number } | null {
    return this.requireObjectTable().typeAndSize(oid);
  }

  read(oid: string): RawObject | null {
    return this.requireObjectTable().read(oid);
  }

  readAuthenticatedObject(oid: string, expectedType: ObjectType): RawObject | null {
    return this.requireObjectTable().readAuthenticatedObject(oid, expectedType);
  }

  readAuthenticatedObjectOwned(oid: string, expectedType: ObjectType): RawObject | null {
    return this.requireObjectTable().readAuthenticatedObjectOwned(oid, expectedType);
  }

  objectInfo(oids: readonly string[]): ObjectReadInfo[] {
    return this.requireObjectTable().objectInfo(oids);
  }

  readObjects(oids: readonly string[], options: { budgetBytes?: number } = {}): ObjectReadBatch {
    return this.requireObjectTable().readObjects(oids, options);
  }

  readBlobs(oids: readonly string[], options: { budgetBytes?: number } = {}): BlobReadBatch {
    return this.requireObjectTable().readBlobs(oids, options);
  }

  *walkTree(treeOid: string): Generator<WalkTreeEntry> {
    yield* iterateTree(this.db, this.repoId, treeOid);
  }

  *walkTreeDiff(
    beforeTreeOid: string | null,
    afterTreeOid: string | null,
  ): Generator<WalkTreeDiffEntry> {
    yield* iterateTreeDiff(this.db, this.repoId, beforeTreeOid, afterTreeOid);
  }

  *walkTreeDiffObjects(
    beforeTreeOid: string | null,
    afterTreeOid: string,
  ): Generator<WalkTreeDiffObject> {
    yield* iterateTreeDiffObjects(this.db, this.repoId, beforeTreeOid, afterTreeOid);
  }

  write(type: ObjectType, data: Uint8Array): string {
    return withGitMutationGuard(this.db, () => this.writeOwned(type, data));
  }

  protected writeOwned(type: ObjectType, data: Uint8Array): string {
    return this.requireObjectTable().write(type, data);
  }

  writeStream(type: ObjectType, size: number, chunks: () => Iterable<Uint8Array>): string {
    return withGitMutationGuard(this.db, () => this.writeStreamOwned(type, size, chunks));
  }

  protected writeStreamOwned(
    type: ObjectType,
    size: number,
    chunks: () => Iterable<Uint8Array>,
  ): string {
    return this.requireObjectTable().writeStream(type, size, chunks);
  }

  writeBatch(options: ObjectBatchOptions = {}): ObjectBatch {
    return this.requireObjectTable().writeBatchGuarded(options, (body) =>
      withGitMutationGuard(this.db, body),
    );
  }

  protected writeBatchOwned(options: ObjectBatchOptions = {}): OwnedObjectBatch {
    return this.requireObjectTable().writeBatchOwned(options);
  }

  protected objectTableOwned(): ObjectTable {
    return this.requireObjectTable();
  }

  writeObjects<T>(body: (batch: ObjectBatch) => T, options: ObjectBatchOptions = {}): T {
    return withGitMutationGuard(this.db, () =>
      this.requireObjectTable().writeObjects(body, options),
    );
  }

  readChunks(oid: string): Iterable<Uint8Array> | null {
    return this.requireObjectTable().readChunks(oid);
  }

  resolvePrefix(prefix: string): string | null {
    return this.requireObjectTable().resolvePrefix(prefix);
  }

  objectCount(): number {
    return this.requireObjectTable().objectCount();
  }
}
