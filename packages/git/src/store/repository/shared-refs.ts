import { GitError } from "../../common/errors.js";
import type {
  BoundedSingleConfigValue,
  ConfigValueCardinality,
  FetchPublicationPlan,
  FetchPublicationToken,
  RefLogEntry,
  RefLogMetadata,
  RefLogReadOptions,
  RefMutation,
  RefRow,
  TrackingRefPublicationToken,
} from "../core/contracts.js";
import { withGitMutationGuard } from "../core/mutation-guard.js";
import { requireConfigPath, requireConfigSectionMove } from "../refs/config.js";
import { activeRefLogOids, readRefLog } from "../refs/reflog.js";
import type { HeadOwner } from "../refs/refs.js";
import {
  type CommitCacheEntry,
  type CommitCacheWriteResult,
  type CommitGraphLimits,
  indexCommitSource,
  insertCommitCaches,
  prepareCommitCache,
  readCommitCache,
  readCommitGraph,
} from "../trees/commits.js";
import { SharedRepoObjectStore } from "./shared-objects.js";

/** Ref, config, commit-projection, and shallow capabilities of a shared store. */
export abstract class SharedRepoRefStore extends SharedRepoObjectStore {
  getRef(name: string): string | null {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.refTable().getRef(name);
  }

  setRef(name: string, target: string): void {
    withGitMutationGuard(this.db, () => this.setRefOwned(name, target));
  }

  protected setRefOwned(name: string, target: string): void {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    this.refTable().setRef(this.requireHeads(), name, target);
  }

  updateRefExpected(name: string, expectedOid: string, targetOid: string): void {
    withGitMutationGuard(this.db, () => this.updateRefExpectedOwned(name, expectedOid, targetOid));
  }

  protected updateRefExpectedOwned(name: string, expectedOid: string, targetOid: string): void {
    this.refTable().updateRefExpected(this.requireHeads(), name, expectedOid, targetOid);
  }

  deleteRef(name: string): void {
    withGitMutationGuard(this.db, () => this.deleteRefOwned(name));
  }

  protected deleteRefOwned(name: string): void {
    if (name === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    this.refTable().deleteRef(this.requireHeads(), name);
  }

  updateRefs(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    withGitMutationGuard(this.db, () => this.updateRefsOwned(puts, deletes));
  }

  protected updateRefsOwned(puts: Iterable<RefRow>, deletes: Iterable<string> = []): void {
    this.refTable().updateRefs(this.requireHeads(), puts, deletes);
  }

  mutateRefs(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    return withGitMutationGuard(this.db, () => this.mutateSharedRefsOwned(mutation, metadata));
  }

  protected mutateSharedRefsOwned(mutation: RefMutation, metadata: RefLogMetadata): boolean {
    if (mutation.head !== undefined) throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return this.refTable().mutateRefs(this.requireHeads(), mutation, metadata);
  }

  protected mutateRefsOwned(
    headOwner: HeadOwner,
    mutation: RefMutation,
    metadata: RefLogMetadata,
  ): boolean {
    return this.refTable().mutateRefs(headOwner, mutation, metadata);
  }

  beginTrackingRefPublication(
    trackingPrefix: string,
    refName: string,
  ): TrackingRefPublicationToken {
    return this.fetchPublicationTable().beginTrackingRefPublication(trackingPrefix, refName);
  }

  publishTrackingRef(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean {
    return withGitMutationGuard(this.db, () =>
      this.publishTrackingRefOwned(token, target, metadata),
    );
  }

  protected publishTrackingRefOwned(
    token: TrackingRefPublicationToken,
    target: string | null,
    metadata: RefLogMetadata,
  ): boolean {
    return this.fetchPublicationTable().publishTrackingRef(token, target, metadata);
  }

  beginFetchPublication(
    trackingPrefix: string,
    candidateExactRefs: Iterable<string> = [],
  ): FetchPublicationToken {
    return this.fetchPublicationTable().beginFetchPublication(trackingPrefix, candidateExactRefs);
  }

  publishFetchRefs(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return withGitMutationGuard(this.db, () => this.publishFetchRefsOwned(token, plan, metadata));
  }

  protected publishFetchRefsOwned(
    token: FetchPublicationToken,
    plan: FetchPublicationPlan,
    metadata: RefLogMetadata,
  ): boolean {
    return this.fetchPublicationTable().publishFetchRefs(token, plan, metadata);
  }

  listRefs(prefix = ""): RefRow[] {
    return this.refTable().listRefs(prefix);
  }

  /** Stream one validated, repository-scoped raw-ref snapshot in Git byte order. */
  *iterateRefs(): Generator<RefRow> {
    yield* this.refTable().iterateRefs();
  }

  reflog(refName: string, options: RefLogReadOptions = {}): RefLogEntry[] {
    if (refName === "HEAD") throw new GitError("EINVAL", "HEAD belongs to a checkout");
    return readRefLog(
      this.db,
      this.repoId,
      this.requireOperations().checkoutId,
      this.refLogClock(),
      refName,
      options,
    );
  }

  activeRefLogOids(): Generator<string> {
    return activeRefLogOids(
      this.db,
      this.repoId,
      this.requireOperations().checkoutId,
      this.refLogClock(),
    );
  }

  configGetAll(path: string): string[] {
    return this.configTable().getAll(path);
  }

  configGet(path: string): string | undefined {
    return this.configTable().get(path);
  }

  configGetOwned(path: string): string | undefined {
    return this.configTable().getOwned(path);
  }

  configGetBounded(path: string, maxBytes?: number): string | undefined {
    return this.configTable().getBounded(path, maxBytes);
  }

  configGetSingleBounded(path: string, maxBytes?: number): BoundedSingleConfigValue {
    return this.configTable().getSingleBounded(path, maxBytes);
  }

  configCardinality(path: string): ConfigValueCardinality {
    return this.configTable().cardinality(path);
  }

  configSet(path: string, value: string): void {
    const checkedPath = requireConfigPath(path);
    withGitMutationGuard(this.db, () => this.configSetOwned(checkedPath, value));
  }

  protected configSetOwned(path: string, value: string): void {
    this.configTable().set(path, value);
  }

  configAdd(path: string, value: string): void {
    const checkedPath = requireConfigPath(path);
    withGitMutationGuard(this.db, () => this.configAddOwned(checkedPath, value));
  }

  protected configAddOwned(path: string, value: string): void {
    this.configTable().add(path, value);
  }

  configUnset(path: string): void {
    const checkedPath = requireConfigPath(path);
    withGitMutationGuard(this.db, () => this.configUnsetOwned(checkedPath));
  }

  protected configUnsetOwned(path: string): void {
    this.configTable().unset(path);
  }

  configPaths(prefix: string): string[] {
    return this.configTable().paths(prefix);
  }

  configMoveSection(sourcePrefix: string, destinationPrefix: string): void {
    const [source, destination] = requireConfigSectionMove(sourcePrefix, destinationPrefix);
    withGitMutationGuard(this.db, () => this.configMoveSectionOwned(source, destination));
  }

  protected configMoveSectionOwned(sourcePrefix: string, destinationPrefix: string): void {
    this.configTable().moveSection(sourcePrefix, destinationPrefix);
  }

  cachedCommit(oid: string): CommitCacheEntry | null {
    return readCommitCache(this.db, this.repoId, oid);
  }

  prepareCommit(oid: string, data: Uint8Array): CommitCacheEntry {
    return prepareCommitCache({ repoId: this.repoId, oid, data });
  }

  cacheCommit(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return withGitMutationGuard(this.db, () => this.cacheCommitOwned(oid, data));
  }

  protected cacheCommitOwned(oid: string, data: Uint8Array): CommitCacheEntry | null {
    return indexCommitSource(this.db, { repoId: this.repoId, oid, data });
  }

  cacheCommits(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return withGitMutationGuard(this.db, () => this.cacheCommitsOwned(entries));
  }

  protected cacheCommitsOwned(entries: Iterable<CommitCacheEntry>): CommitCacheWriteResult {
    return insertCommitCaches(this.db, entries);
  }

  commitGraph(rootOid: string, limits: CommitGraphLimits = {}): Iterable<CommitCacheEntry> {
    return readCommitGraph(this.db, this.repoId, rootOid, limits);
  }

  destroy(): void {
    withGitMutationGuard(this.db, () => this.destroyOwned());
  }

  protected destroyOwned(): void {
    this.requireOperations().destroyOwned();
  }
}
