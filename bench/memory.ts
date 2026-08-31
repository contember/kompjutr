import { createHash } from "node:crypto";
import { fromHex, utf8 } from "../src/core/bytes.js";
import type { GitContext } from "../src/core/context.js";
import { type Commit, hashObject, serializeCommit, serializeTree } from "../src/core/objects.js";
import { requireCleanIntegrationWorktree } from "../src/core/ops/integration-worktree.js";
import { type RebaseLifecycleResult, rebase } from "../src/core/ops/rebase.js";
import { add } from "../src/core/ops/staging.js";
import { Repository } from "../src/core/repository.js";
import type { Worktree, WorktreeDirent, WorktreeStat } from "../src/core/worktree.js";
import { CHUNK_SIZE } from "../src/fs/schema.js";
import { createInitialWorktreeWriter } from "../src/fs/store/initial-write.js";
import type {
  DiscoverFilesOptions,
  DiscoverFilesPage,
  Filesystem,
  HandleReadBatch,
  ReadBatch,
  RealPath,
  RegularFileHandle,
  RemoveOptions,
  ScanEntry,
  ScanOptions,
  WriteEntry,
  WriteOptions,
} from "../src/fs/types.js";
import { advanceMaintenanceReachability } from "../src/sqlite/maintenance/reachability.js";
import { type CheckoutRow, type SharedRepoStore, SqliteGitDatabase } from "../src/sqlite/store.js";
import { commitGraphBytes } from "./commit-graph-bytes.js";
import type { Harness, Scenario } from "./harness.js";
import {
  CHECKOUT_COUNT,
  CHECKOUT_HEAD_BYTES,
  CHECKOUT_ROOT_BYTES,
  GRAPH_COMMIT_COUNT,
  GRAPH_MESSAGE_BYTES,
  HASH_WORKLOAD_BYTES,
  LARGE_CONFIG_BYTES,
  LARGE_HEADER_BYTES,
  LARGE_OBJECT_BYTES,
  type MemoryPhaseEvidence,
  type MemoryScenarioSpec,
  memoryScenarioSpec,
} from "./memory-protocol.js";

const INITIAL_SPEC = memoryScenarioSpec("fs.initial-write");
const REDIRECT_SPEC = memoryScenarioSpec("fs.redirect.stream");
const INITIAL_SYMLINK_BYTES = 64 * 1024 + 1;
const INITIAL_PATTERN_SEED = 0xa5;
const REDIRECT_PATTERN_SEED = 0x5a;
const INTEGRATION_PATTERN_SEED = 0x31;
const REBASE_BASE_PATTERN_SEED = 0x62;
const REBASE_TARGET_PATTERN_SEED = 0x74;
const STAGING_PATTERN_SEED = 0x43;
const PACK_STREAM_CHUNK_BYTES = 1024 * 1024;
const PACK_FIXTURE_DATA = new Uint8Array([0x62]);
const BENCH_PERSON = {
  name: "Memory Benchmark",
  email: "memory@example.com",
  timestamp: 1_577_836_800,
  timezoneOffset: 0,
};

class CountingWorktree implements Worktree {
  rangeReads = 0;

  constructor(protected readonly inner: Worktree) {}

  stat(path: string): WorktreeStat | null {
    return this.inner.stat(path);
  }
  realpath(path: string): RealPath {
    return this.inner.realpath(path);
  }
  readFile(path: string): Uint8Array {
    return this.inner.readFile(path);
  }
  writeFile(
    path: string,
    data: Uint8Array,
    options?: { mode?: number; contentId?: Uint8Array },
  ): void {
    this.inner.writeFile(path, data, options);
  }
  readlink(path: string): string {
    return this.inner.readlink(path);
  }
  symlink(target: string, path: string): void {
    this.inner.symlink(target, path);
  }
  readdir(path: string): WorktreeDirent[] {
    return this.inner.readdir(path);
  }
  unlink(path: string): void {
    this.inner.unlink(path);
  }
  rmdir(path: string): void {
    this.inner.rmdir(path);
  }
  chmod(path: string, mode: number): void {
    this.inner.chmod(path, mode);
  }
  readRange(path: string, offset: number, length: number): Uint8Array {
    this.rangeReads++;
    return this.inner.readRange(path, offset, length);
  }
  createFile(path: string, mode: number): void {
    this.inner.createFile(path, mode);
  }
  writeRange(path: string, data: Uint8Array, offset: number): void {
    this.inner.writeRange(path, data, offset);
  }
  scan(root: string, options: ScanOptions): ScanEntry[] {
    return this.inner.scan(root, options);
  }
  discoverFiles(
    root: RealPath,
    pattern: string,
    options?: DiscoverFilesOptions,
  ): DiscoverFilesPage {
    return this.inner.discoverFiles(root, pattern, options);
  }
  readFileHandles(
    handles: readonly RegularFileHandle[],
    options?: { budget?: number },
  ): HandleReadBatch {
    return this.inner.readFileHandles(handles, options);
  }
  readFiles(paths: readonly string[], options?: { budget?: number }): ReadBatch {
    return this.inner.readFiles(paths, options);
  }
  glob(root: string, pattern: string, options?: { limit?: number }): string[] {
    return this.inner.glob(root, pattern, options);
  }
  writeFiles(entries: readonly WriteEntry[], options?: WriteOptions): void {
    this.inner.writeFiles(entries, options);
  }
  makeDirectories(paths: readonly string[]): void {
    this.inner.makeDirectories(paths);
  }
  removeFiles(paths: readonly string[], options?: RemoveOptions): void {
    this.inner.removeFiles(paths, options);
  }
}

class LateMetadataWorktree extends CountingWorktree {
  #scanCalls = 0;

  constructor(
    inner: Worktree,
    private readonly cleanContentId: Uint8Array,
  ) {
    super(inner);
  }

  override scan(root: string, options: ScanOptions): ScanEntry[] {
    const page = super.scan(root, options);
    this.#scanCalls++;
    return page.map((entry) =>
      entry.path === "/guard.bin" && this.#scanCalls > 2
        ? { ...entry, mtime: entry.mtime + 1, rev: entry.rev + 1, contentId: null }
        : entry.path === "/guard.bin"
          ? { ...entry, contentId: this.cleanContentId }
          : entry,
    );
  }
}

function* patternedChunks(size: number, seed: number): Generator<Uint8Array> {
  const chunk = new Uint8Array(CHUNK_SIZE);
  let index = 0;
  for (let remaining = size; remaining > 0; remaining -= CHUNK_SIZE, index++) {
    chunk.fill((seed + index * 31) & 0xff);
    yield remaining >= CHUNK_SIZE ? chunk : chunk.subarray(0, remaining);
  }
}

function generatedDigest(size: number, seed: number): string {
  const hash = createHash("sha256");
  for (const chunk of patternedChunks(size, seed)) hash.update(chunk);
  return hash.digest("hex");
}

function generatedObjectOid(size: number, seed: number): string {
  const hash = createHash("sha1");
  hash.update(`blob ${size}\0`);
  for (const chunk of patternedChunks(size, seed)) hash.update(chunk);
  return hash.digest("hex");
}

function bytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestParts(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function ownedEvidence(spec: MemoryScenarioSpec, digest: string | null): MemoryPhaseEvidence {
  if (digest === null)
    throw new Error("memory scenario did not publish complete semantic evidence");
  return {
    source: spec.source,
    workloadBytes: spec.workloadBytes,
    formerLimitBytes: spec.formerLimitBytes,
    verifiedContentBytes: spec.verifiedContentBytes,
    verifiedChunkCount: spec.verifiedChunkCount,
    verificationDigest: digest,
  };
}

function createRepository(
  harness: Harness,
  root = "/",
): {
  database: SqliteGitDatabase;
  repo: Repository;
} {
  const database = new SqliteGitDatabase(harness.workspace.db, {
    chunkBytes: 0,
    objectCacheBytes: 0,
    now: () => 1_577_836_800_000,
  });
  const checkout = database.createRepository(root, "ref: refs/heads/main");
  return { database, repo: new Repository(database.openCheckout(checkout)) };
}

function reopenRepository(
  harness: Harness,
  root = "/",
): {
  database: SqliteGitDatabase;
  repo: Repository;
} {
  const database = new SqliteGitDatabase(harness.workspace.db, {
    chunkBytes: 0,
    objectCacheBytes: 0,
    now: () => 1_577_836_800_000,
  });
  const checkout = database.findCheckout(root);
  if (checkout === null) throw new Error(`memory fixture repository ${root} is missing`);
  return { database, repo: new Repository(database.openCheckout(checkout)) };
}

function digestObjectChunks(
  store: SharedRepoStore,
  oid: string,
): { digest: string; bytes: number } {
  const chunks = store.readChunks(oid);
  if (chunks === null) throw new Error(`loose object ${oid} has no chunk stream`);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const chunk of chunks) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { digest: hash.digest("hex"), bytes };
}

function storedZlibByteLength(dataBytes: number, minimumBytes: number): number {
  const fixedBytes = 2 + 5 + dataBytes + 4;
  return fixedBytes + Math.max(0, Math.ceil((minimumBytes + 1 - fixedBytes) / 5)) * 5;
}

function* storedZlibChunks(data: Uint8Array, minimumBytes: number): Generator<Uint8Array> {
  if (data.length > 0xffff) throw new Error("stored zlib fixture data is too large");
  const fixedBytes = 2 + 5 + data.length + 4;
  let emptyBlocks = Math.max(0, Math.ceil((minimumBytes + 1 - fixedBytes) / 5));
  yield new Uint8Array([0x78, 0x01]);
  const blocksPerChunk = Math.floor(PACK_STREAM_CHUNK_BYTES / 5);
  const emptyChunk = new Uint8Array(blocksPerChunk * 5);
  for (let offset = 0; offset < emptyChunk.length; offset += 5) {
    emptyChunk.set([0, 0, 0, 0xff, 0xff], offset);
  }
  while (emptyBlocks > 0) {
    const blocks = Math.min(emptyBlocks, blocksPerChunk);
    yield blocks === blocksPerChunk ? emptyChunk : emptyChunk.subarray(0, blocks * 5);
    emptyBlocks -= blocks;
  }
  let first = 1;
  let second = 0;
  for (const byte of data) {
    first = (first + byte) % 65_521;
    second = (second + first) % 65_521;
  }
  const checksum = second * 65_536 + first;
  const final = new Uint8Array(5 + data.length + 4);
  final.set(
    [1, data.length & 0xff, data.length >>> 8, ~data.length & 0xff, (~data.length >>> 8) & 0xff],
    0,
  );
  final.set(data, 5);
  final.set(
    [checksum >>> 24, (checksum >>> 16) & 0xff, (checksum >>> 8) & 0xff, checksum & 0xff],
    5 + data.length,
  );
  yield final;
}

async function* singleBlobPackStream(
  data: Uint8Array,
  minimumCompressedBytes: number,
): AsyncGenerator<Uint8Array> {
  if (data.length > 15) throw new Error("compressed pack fixture data is too large");
  const hash = createHash("sha1");
  const header = new Uint8Array([
    0x50,
    0x41,
    0x43,
    0x4b,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    1,
    0x30 | data.length,
  ]);
  hash.update(header);
  yield header;
  for (const chunk of storedZlibChunks(data, minimumCompressedBytes)) {
    hash.update(chunk);
    yield chunk;
  }
  yield hash.digest();
}

function deterministicBytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  let state = 0x9e3779b9;
  for (let index = 0; index < data.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = state & 0xff;
  }
  return data;
}

function* largeHeaderChunks(size: number, prefix: Uint8Array): Generator<Uint8Array> {
  if (prefix.length + 2 > size) throw new Error("large header prefix exceeds its object size");
  for (let offset = 0; offset < size; offset += 1024 * 1024) {
    const length = Math.min(1024 * 1024, size - offset);
    const chunk = new Uint8Array(length).fill(0x61);
    if (offset === 0) chunk.set(prefix);
    if (offset + length === size) {
      chunk[length - 2] = 0x0a;
      chunk[length - 1] = 0x0a;
    }
    yield chunk;
  }
}

function streamedObjectOid(
  type: "commit" | "tag",
  size: number,
  chunks: () => Iterable<Uint8Array>,
): string {
  const hash = createHash("sha1");
  hash.update(`${type} ${size}\0`);
  for (const chunk of chunks()) hash.update(chunk);
  return hash.digest("hex");
}

function storedDigest(
  filesystem: Filesystem,
  path: string,
  size: number,
): { digest: string; chunks: number } {
  const hash = createHash("sha256");
  let chunks = 0;
  for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
    const expected = Math.min(CHUNK_SIZE, size - offset);
    const bytes = filesystem.readRange(path, offset, expected);
    if (bytes.length !== expected) throw new Error(`${path} returned a short verification chunk`);
    hash.update(bytes);
    chunks++;
  }
  return { digest: hash.digest("hex"), chunks };
}

function verifyStoredPattern(
  filesystem: Filesystem,
  path: string,
  size: number,
  seed: number,
): { digest: string; chunks: number } {
  const actual = storedDigest(filesystem, path, size);
  const expected = generatedDigest(size, seed);
  if (actual.digest !== expected)
    throw new Error(`${path} full-content digest verification failed`);
  return actual;
}

function initialWriteScenario(): Scenario {
  let verificationDigest: string | null = null;
  const target = "t".repeat(INITIAL_SYMLINK_BYTES);
  return {
    name: INITIAL_SPEC.scenario,
    kind: "memory",
    fileBacked: true,
    async setup() {},
    phases: [
      {
        name: INITIAL_SPEC.operation,
        async run({ harness }) {
          const result = createInitialWorktreeWriter(
            harness.workspace.filesystem.db,
            () => 1_577_836_800_000,
          ).tryRun("/repo", (session) => {
            session.writeSymlink("large-link", target);
            session.writeFileStream(
              "z-stream.bin",
              INITIAL_SPEC.verifiedContentBytes,
              patternedChunks(INITIAL_SPEC.verifiedContentBytes, INITIAL_PATTERN_SEED),
            );
          });
          if (result.kind !== "committed") throw new Error("initial writer was unavailable");
        },
        async verify({ harness }) {
          const filesystem = harness.workspace.filesystem;
          const stat = filesystem.stat("/repo/z-stream.bin");
          if (stat?.type !== "file" || stat.size !== INITIAL_SPEC.verifiedContentBytes) {
            throw new Error("initial stream size verification failed");
          }
          if (filesystem.readlink("/repo/large-link") !== target) {
            throw new Error("initial symlink verification failed");
          }
          const verified = verifyStoredPattern(
            filesystem,
            "/repo/z-stream.bin",
            INITIAL_SPEC.verifiedContentBytes,
            INITIAL_PATTERN_SEED,
          );
          if (verified.chunks !== INITIAL_SPEC.verifiedChunkCount) {
            throw new Error("initial stream verification chunk count is inconsistent");
          }
          verificationDigest = verified.digest;
        },
        memoryEvidence(): MemoryPhaseEvidence {
          if (verificationDigest === null)
            throw new Error("initial writer did not publish evidence");
          return {
            source: INITIAL_SPEC.source,
            workloadBytes: INITIAL_SPEC.workloadBytes,
            formerLimitBytes: INITIAL_SPEC.formerLimitBytes,
            verifiedContentBytes: INITIAL_SPEC.verifiedContentBytes,
            verifiedChunkCount: INITIAL_SPEC.verifiedChunkCount,
            verificationDigest,
          };
        },
      },
    ],
  };
}

function redirectStreamScenario(): Scenario {
  let verificationDigest: string | null = null;
  return {
    name: REDIRECT_SPEC.scenario,
    kind: "memory",
    fileBacked: true,
    async setup() {},
    phases: [
      {
        name: REDIRECT_SPEC.operation,
        async run({ harness }) {
          harness.workspace.filesystem.writeFileStream(
            "/redirect.bin",
            patternedChunks(REDIRECT_SPEC.verifiedContentBytes, REDIRECT_PATTERN_SEED),
          );
        },
        async verify({ harness }) {
          const filesystem = harness.workspace.filesystem;
          const stat = filesystem.stat("/redirect.bin");
          if (stat?.type !== "file" || stat.size !== REDIRECT_SPEC.verifiedContentBytes) {
            throw new Error("redirect stream size verification failed");
          }
          const verified = verifyStoredPattern(
            filesystem,
            "/redirect.bin",
            REDIRECT_SPEC.verifiedContentBytes,
            REDIRECT_PATTERN_SEED,
          );
          if (verified.chunks !== REDIRECT_SPEC.verifiedChunkCount) {
            throw new Error("redirect verification chunk count is inconsistent");
          }
          verificationDigest = verified.digest;
        },
        memoryEvidence(): MemoryPhaseEvidence {
          if (verificationDigest === null) throw new Error("redirect did not publish its digest");
          return {
            source: REDIRECT_SPEC.source,
            workloadBytes: REDIRECT_SPEC.workloadBytes,
            formerLimitBytes: REDIRECT_SPEC.formerLimitBytes,
            verifiedContentBytes: REDIRECT_SPEC.verifiedContentBytes,
            verifiedChunkCount: REDIRECT_SPEC.verifiedChunkCount,
            verificationDigest,
          };
        },
      },
    ],
  };
}

function integrationGuardScenario(): Scenario {
  const spec = memoryScenarioSpec("core.integration.guard-hash");
  const expectedOid = generatedObjectOid(HASH_WORKLOAD_BYTES, INTEGRATION_PATTERN_SEED);
  const expectedDigest = generatedDigest(HASH_WORKLOAD_BYTES, INTEGRATION_PATTERN_SEED);
  let repo: Repository | null = null;
  let worktree: CountingWorktree | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      const created = createRepository(harness);
      harness.workspace.filesystem.writeFileStream(
        "/guard.bin",
        patternedChunks(HASH_WORKLOAD_BYTES, INTEGRATION_PATTERN_SEED),
      );
      created.repo.checkout.indexPut({
        path: "guard.bin",
        stage: 0,
        mode: 0o100644,
        oid: expectedOid,
        size: null,
        mtime: null,
        ino: null,
      });
      repo = reopenRepository(harness).repo;
      worktree = new CountingWorktree(harness.workspace.filesystem);
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (repo === null || worktree === null) throw new Error("integration fixture is missing");
          requireCleanIntegrationWorktree(repo, worktree, "merge");
        },
        async verify({ harness }) {
          if (repo === null || worktree === null) throw new Error("integration fixture is missing");
          if (worktree.rangeReads !== spec.verifiedChunkCount) {
            throw new Error("integration guard did not hash the complete ranged workload");
          }
          if (repo.checkout.indexGet("guard.bin")?.oid !== expectedOid) {
            throw new Error("integration guard changed the tracked identity");
          }
          const stored = storedDigest(
            harness.workspace.filesystem,
            "/guard.bin",
            HASH_WORKLOAD_BYTES,
          );
          if (stored.digest !== expectedDigest) {
            throw new Error("integration guard worktree content changed");
          }
          verificationDigest = stored.digest;
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function rebaseBaselineScenario(): Scenario {
  const spec = memoryScenarioSpec("core.rebase.baseline-hash");
  const targetDigest = generatedDigest(HASH_WORKLOAD_BYTES, REBASE_TARGET_PATTERN_SEED);
  let context: GitContext | null = null;
  let repo: Repository | null = null;
  let worktree: LateMetadataWorktree | null = null;
  let upstreamOid: string | null = null;
  let result: RebaseLifecycleResult | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      await harness.git.init({ dir: "/" });
      harness.workspace.filesystem.writeFileStream(
        "/guard.bin",
        patternedChunks(HASH_WORKLOAD_BYTES, REBASE_BASE_PATTERN_SEED),
      );
      await harness.git.add({ dir: "/", paths: ["guard.bin"] });
      await harness.git.commit({ dir: "/", message: "base" });
      const currentBranch = await harness.git.currentBranch({ dir: "/" });
      if (currentBranch === undefined) throw new Error("rebase fixture has no current branch");
      await harness.git.branch({ dir: "/", name: "upstream" });
      await harness.git.checkout({ dir: "/", ref: "upstream" });
      harness.workspace.filesystem.writeFileStream(
        "/guard.bin",
        patternedChunks(HASH_WORKLOAD_BYTES, REBASE_TARGET_PATTERN_SEED),
      );
      await harness.git.add({ dir: "/", paths: ["guard.bin"] });
      upstreamOid = (await harness.git.commit({ dir: "/", message: "upstream" })).oid;
      await harness.git.checkout({ dir: "/", ref: currentBranch });

      const reopened = reopenRepository(harness);
      repo = reopened.repo;
      const guard = repo.checkout.indexGet("guard.bin");
      if (guard === null) throw new Error("rebase guard index entry is missing");
      worktree = new LateMetadataWorktree(harness.workspace.filesystem, fromHex(guard.oid));
      context = {
        database: reopened.database,
        worktree,
        now: () => 1_577_836_800_000,
        timezoneOffset: () => 0,
        defaultIdentity: { name: "Bench", email: "bench@example.com" },
      };
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (context === null || repo === null || worktree === null) {
            throw new Error("rebase fixture is missing");
          }
          result = rebase(context, repo, worktree, { upstream: "upstream" });
        },
        async verify({ harness }) {
          if (repo === null || worktree === null || upstreamOid === null || result === null) {
            throw new Error("rebase fixture is missing");
          }
          if (
            result.outcome !== "completed" ||
            !result.fastForward ||
            result.oid !== upstreamOid ||
            repo.head().oid !== upstreamOid
          ) {
            throw new Error("rebase baseline did not fast-forward to the authenticated target");
          }
          if (worktree.rangeReads !== spec.verifiedChunkCount) {
            throw new Error("rebase baseline did not hash the complete ranged workload");
          }
          if (repo.checkout.readOperationState() !== null) {
            throw new Error("rebase baseline retained operation state");
          }
          const stored = storedDigest(
            harness.workspace.filesystem,
            "/guard.bin",
            HASH_WORKLOAD_BYTES,
          );
          if (stored.digest !== targetDigest)
            throw new Error("rebase baseline wrote wrong content");
          verificationDigest = stored.digest;
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function stagingAddScenario(): Scenario {
  const spec = memoryScenarioSpec("core.staging.add-hash");
  const expectedOid = generatedObjectOid(HASH_WORKLOAD_BYTES, STAGING_PATTERN_SEED);
  const expectedDigest = generatedDigest(HASH_WORKLOAD_BYTES, STAGING_PATTERN_SEED);
  let repo: Repository | null = null;
  let worktree: CountingWorktree | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      createRepository(harness);
      harness.workspace.filesystem.writeFileStream(
        "/large.bin",
        patternedChunks(HASH_WORKLOAD_BYTES, STAGING_PATTERN_SEED),
      );
      repo = reopenRepository(harness).repo;
      worktree = new CountingWorktree(harness.workspace.filesystem);
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (repo === null || worktree === null) throw new Error("staging fixture is missing");
          add(repo, worktree, { paths: ["large.bin"] });
        },
        async verify() {
          if (repo === null || worktree === null) throw new Error("staging fixture is missing");
          if (worktree.rangeReads !== spec.verifiedChunkCount) {
            throw new Error("staging add did not hash both complete ranged passes");
          }
          const entry = repo.checkout.indexGet("large.bin");
          if (entry?.oid !== expectedOid || entry.size !== HASH_WORKLOAD_BYTES) {
            throw new Error("staging add wrote the wrong index identity");
          }
          const stored = digestObjectChunks(repo.store, expectedOid);
          if (stored.bytes !== HASH_WORKLOAD_BYTES || stored.digest !== expectedDigest) {
            throw new Error("staging add wrote the wrong loose object bytes");
          }
          verificationDigest = stored.digest;
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function maintenanceReachabilityScenario(): Scenario {
  const spec = memoryScenarioSpec("sqlite.maintenance.reachability");
  let store: SharedRepoStore | null = null;
  let rootOid: string | null = null;
  let treeOid: string | null = null;
  let processedOid: string | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      const created = createRepository(harness, "/repo");
      treeOid = created.repo.store.write("tree", serializeTree([]));
      const prefix = utf8.encode(
        `tree ${treeOid}\nauthor Memory Benchmark <memory@example.com> 1577836800 +0000\n` +
          "committer Memory Benchmark <memory@example.com> 1577836800 +0000\nx ",
      );
      const chunks = () => largeHeaderChunks(LARGE_HEADER_BYTES, prefix);
      rootOid = streamedObjectOid("commit", LARGE_HEADER_BYTES, chunks);
      created.repo.store.db.run(
        "INSERT INTO git_objects (repo_id, oid, type, size, stored) VALUES (?, ?, 'commit', ?, 'raw')",
        created.repo.store.repoId,
        rootOid,
        LARGE_HEADER_BYTES,
      );
      let seq = 0;
      for (const chunk of chunks()) {
        created.repo.store.db.run(
          "INSERT INTO git_object_chunks (repo_id, oid, seq, data) VALUES (?, ?, ?, ?)",
          created.repo.store.repoId,
          rootOid,
          seq++,
          chunk,
        );
      }
      if (seq !== spec.verifiedChunkCount) {
        throw new Error("reachability fixture has an unexpected storage chunk count");
      }
      created.repo.store.db.run(
        `INSERT OR IGNORE INTO git_maintenance_control (repo_id, root_epoch, next_run_id)
         VALUES (?, 0, 2)`,
        created.repo.store.repoId,
      );
      created.repo.store.db.run(
        `INSERT INTO git_maintenance_runs
           (repo_id, run_id, observed_root_epoch, phase, started_ms, root_source,
            reachable_objects, queued_objects)
         VALUES (?, 1, 0, 'mark', 1, 'done', 0, 1)`,
        created.repo.store.repoId,
      );
      created.repo.store.db.run(
        `INSERT INTO git_maintenance_objects
           (repo_id, run_id, oid, source_mask, expanded, shallow_boundary,
            physical_only, edge_cursor)
         VALUES (?, 1, ?, 1, 0, 0, 0, 0)`,
        created.repo.store.repoId,
        rootOid,
      );
      store = reopenRepository(harness, "/repo").repo.store;
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (store === null) throw new Error("reachability fixture is missing");
          const progress = advanceMaintenanceReachability(store);
          processedOid = progress.processedOid;
        },
        async verify() {
          if (store === null || rootOid === null || treeOid === null) {
            throw new Error("reachability fixture is missing");
          }
          const rows = store.db.all<{ oid: string; expanded: number }>(
            `SELECT oid, expanded FROM git_maintenance_objects
              WHERE repo_id = ? AND run_id = 1 AND oid IN (?, ?) ORDER BY oid`,
            store.repoId,
            rootOid,
            treeOid,
          );
          if (
            processedOid !== rootOid ||
            rows.length !== 2 ||
            rows.find((row) => row.oid === rootOid)?.expanded !== 1 ||
            rows.find((row) => row.oid === treeOid)?.expanded !== 0
          ) {
            throw new Error("reachability did not publish the exact large-header root edge");
          }
          verificationDigest = digestParts([rootOid, treeOid, processedOid, rows.length]);
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function packFallbackAuditScenario(): Scenario {
  const spec = memoryScenarioSpec("sqlite.pack.fallback-audit");
  const oid = hashObject("blob", PACK_FIXTURE_DATA);
  let store: SharedRepoStore | null = null;
  let primaryPackId: number | null = null;
  let fallbackPackId: number | null = null;
  let removed = 0;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      const created = createRepository(harness, "/repo");
      primaryPackId = (
        await created.repo.store.packs.ingest(singleBlobPackStream(PACK_FIXTURE_DATA, 0))
      ).packId;
      fallbackPackId = (
        await created.repo.store.packs.ingest(
          singleBlobPackStream(PACK_FIXTURE_DATA, spec.formerLimitBytes),
        )
      ).packId;
      if (
        storedZlibByteLength(PACK_FIXTURE_DATA.length, spec.formerLimitBytes) !== spec.workloadBytes
      ) {
        throw new Error("fallback audit fixture compressed length is inconsistent");
      }
      store = reopenRepository(harness, "/repo").repo.store;
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (store === null || primaryPackId === null) {
            throw new Error("fallback audit fixture is missing");
          }
          removed = store.packs.deleteCompletePacks([primaryPackId]);
        },
        async verify() {
          if (store === null || primaryPackId === null || fallbackPackId === null) {
            throw new Error("fallback audit fixture is missing");
          }
          const object = store.read(oid);
          if (
            removed !== 1 ||
            store.packs.completePackedEntry(oid)?.packId !== fallbackPackId ||
            store.db.scalar<number>(
              "SELECT count(*) FROM git_pack_meta WHERE repo_id = ? AND pack_id = ?",
              store.repoId,
              primaryPackId,
            ) !== 0 ||
            object?.type !== "blob" ||
            object.data.length !== 1 ||
            object.data[0] !== PACK_FIXTURE_DATA[0]
          ) {
            throw new Error("fallback audit did not authenticate and promote the exact object");
          }
          verificationDigest = bytesDigest(object.data);
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function packAuthenticationScenario(): Scenario {
  const spec = memoryScenarioSpec("sqlite.pack.authenticate");
  const oid = hashObject("blob", PACK_FIXTURE_DATA);
  let store: SharedRepoStore | null = null;
  let packId: number | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      const created = createRepository(harness, "/repo");
      packId = (
        await created.repo.store.packs.ingest(
          singleBlobPackStream(PACK_FIXTURE_DATA, spec.formerLimitBytes),
        )
      ).packId;
      if (
        storedZlibByteLength(PACK_FIXTURE_DATA.length, spec.formerLimitBytes) !== spec.workloadBytes
      ) {
        throw new Error("pack authentication fixture compressed length is inconsistent");
      }
      store = reopenRepository(harness, "/repo").repo.store;
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (store === null || packId === null) {
            throw new Error("pack authentication fixture is missing");
          }
          store.packs.authenticateCompleteSources([
            { oid, type: "blob", size: PACK_FIXTURE_DATA.length, packId },
          ]);
        },
        async verify() {
          if (store === null || packId === null) {
            throw new Error("pack authentication fixture is missing");
          }
          const object = store.read(oid);
          if (
            store.packs.completePackedEntry(oid)?.packId !== packId ||
            object?.type !== "blob" ||
            object.data.length !== 1 ||
            object.data[0] !== PACK_FIXTURE_DATA[0]
          ) {
            throw new Error("pack authentication did not preserve the exact canonical object");
          }
          verificationDigest = bytesDigest(object.data);
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function retainedGraphScenario(): Scenario {
  const spec = memoryScenarioSpec("sqlite.graph.retained");
  const message = `${"g".repeat(GRAPH_MESSAGE_BYTES - 1)}\n`;
  let repo: Repository | null = null;
  let rootOid: string | null = null;
  let walked: { oid: string; commit: Commit }[] | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      const created = createRepository(harness, "/repo");
      const tree = created.repo.store.write("tree", serializeTree([]));
      let parent: string | undefined;
      let retainedBytes = 0;
      for (let index = 0; index < GRAPH_COMMIT_COUNT; index++) {
        const commit: Commit = {
          tree,
          parent: parent === undefined ? [] : [parent],
          author: BENCH_PERSON,
          committer: BENCH_PERSON,
          message,
        };
        retainedBytes += commitGraphBytes(commit);
        parent = created.repo.store.write("commit", serializeCommit(commit));
      }
      if (parent === undefined || retainedBytes !== spec.workloadBytes) {
        throw new Error("retained graph fixture does not match its frozen workload");
      }
      rootOid = parent;
      repo = reopenRepository(harness, "/repo").repo;
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (repo === null || rootOid === null) throw new Error("graph fixture is missing");
          walked = [...repo.walkIndexed(rootOid)];
        },
        async verify() {
          if (repo === null || rootOid === null || walked === null) {
            throw new Error("graph fixture is missing");
          }
          let messageBytes = 0;
          let graphBytes = 0;
          const hash = createHash("sha256");
          for (const entry of walked) {
            messageBytes += utf8.encode(entry.commit.message).length;
            graphBytes += commitGraphBytes(entry.commit);
            hash.update(entry.oid);
            hash.update(entry.commit.message);
          }
          if (
            walked.length !== spec.verifiedChunkCount ||
            walked[0]?.oid !== rootOid ||
            messageBytes !== spec.verifiedContentBytes ||
            graphBytes !== spec.workloadBytes
          ) {
            throw new Error("retained graph walk did not return the exact commit chain");
          }
          verificationDigest = hash.digest("hex");
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function objectSingletonScenario(): Scenario {
  const spec = memoryScenarioSpec("sqlite.object.singleton");
  let store: SharedRepoStore | null = null;
  let oid: string | null = null;
  let object: Uint8Array | null = null;
  let expectedDigest: string | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      const created = createRepository(harness, "/repo");
      const data = deterministicBytes(LARGE_OBJECT_BYTES);
      expectedDigest = bytesDigest(data);
      oid = created.repo.store.write("blob", data);
      store = reopenRepository(harness, "/repo").repo.store;
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (store === null || oid === null) throw new Error("object fixture is missing");
          const read = store.readBlobs([oid], { budgetBytes: 1 });
          object = read.blobs.get(oid) ?? null;
          if (read.remaining.length !== 0 || read.bytes !== LARGE_OBJECT_BYTES) {
            throw new Error("oversized object was not returned as one singleton");
          }
        },
        async verify() {
          if (store === null || oid === null || object === null || expectedDigest === null) {
            throw new Error("object fixture is missing");
          }
          const chunks = store.db.scalar<number>(
            "SELECT count(*) FROM git_object_chunks WHERE repo_id = ? AND oid = ?",
            store.repoId,
            oid,
          );
          verificationDigest = bytesDigest(object);
          if (
            object.length !== spec.verifiedContentBytes ||
            chunks !== spec.verifiedChunkCount ||
            verificationDigest !== expectedDigest ||
            hashObject("blob", object) !== oid
          ) {
            throw new Error("oversized singleton object failed exact byte verification");
          }
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function configMoveScenario(): Scenario {
  const spec = memoryScenarioSpec("sqlite.config.move");
  let store: ReturnType<SqliteGitDatabase["openCheckout"]> | null = null;
  let expectedDigest: string | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      const created = createRepository(harness, "/repo");
      const value = "v".repeat(LARGE_CONFIG_BYTES);
      expectedDigest = createHash("sha256").update(value).digest("hex");
      created.repo.checkout.configSet("branch.old.payload", value);
      store = reopenRepository(harness, "/repo").repo.checkout;
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (store === null) throw new Error("config fixture is missing");
          store.configMoveSection("branch.old.", "branch.new.");
        },
        async verify() {
          if (store === null || expectedDigest === null)
            throw new Error("config fixture is missing");
          const value = store.configGet("branch.new.payload");
          if (
            store.configGet("branch.old.payload") !== undefined ||
            value === undefined ||
            utf8.encode(value).length !== spec.verifiedContentBytes
          ) {
            throw new Error("config section move did not preserve the exact source value");
          }
          verificationDigest = createHash("sha256").update(value).digest("hex");
          if (verificationDigest !== expectedDigest) {
            throw new Error("config section move changed the source value bytes");
          }
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

function checkoutListScenario(): Scenario {
  const spec = memoryScenarioSpec("sqlite.checkout.list");
  let database: SqliteGitDatabase | null = null;
  let checkouts: readonly CheckoutRow[] | null = null;
  let verificationDigest: string | null = null;
  return {
    name: spec.scenario,
    kind: "memory",
    fileBacked: true,
    async setup({ harness }) {
      const setup = new SqliteGitDatabase(harness.workspace.db);
      setup.db.run("INSERT INTO git_repositories (id) VALUES (1)");
      setup.db.run(
        `WITH RECURSIVE sequence(id) AS (
           VALUES (1) UNION ALL SELECT id + 1 FROM sequence WHERE id < ${CHECKOUT_COUNT}
         )
         INSERT INTO git_checkouts (id, repo_id, root, head, is_primary)
         SELECT id, 1,
                printf('/%04d%0*d', id, ${CHECKOUT_ROOT_BYTES - 5}, 0),
                printf('ref: refs/tags/%0*d', ${CHECKOUT_HEAD_BYTES - 15}, id),
                CASE id WHEN 1 THEN 1 ELSE 0 END
           FROM sequence`,
      );
      setup.db.run(
        `UPDATE git_identity_control
            SET last_repo_id = 1, last_checkout_id = ${CHECKOUT_COUNT}
          WHERE singleton = 1`,
      );
      database = new SqliteGitDatabase(harness.workspace.db);
    },
    phases: [
      {
        name: spec.operation,
        async run() {
          if (database === null) throw new Error("checkout fixture is missing");
          checkouts = database.listCheckouts(1);
        },
        async verify() {
          if (database === null || checkouts === null)
            throw new Error("checkout fixture is missing");
          const hash = createHash("sha256");
          let textBytes = 0;
          for (const checkout of checkouts) {
            hash.update(`${checkout.id}\0${checkout.root}\0${checkout.head}\0`);
            textBytes += utf8.encode(checkout.root).length + utf8.encode(checkout.head).length;
          }
          if (
            checkouts.length !== spec.verifiedChunkCount ||
            textBytes !== spec.verifiedContentBytes ||
            !Object.isFrozen(checkouts) ||
            !checkouts.every(Object.isFrozen)
          ) {
            throw new Error("checkout listing did not retain the exact frozen collection");
          }
          verificationDigest = hash.digest("hex");
        },
        memoryEvidence: () => ownedEvidence(spec, verificationDigest),
      },
    ],
  };
}

export const MEMORY: Scenario[] = [
  initialWriteScenario(),
  redirectStreamScenario(),
  integrationGuardScenario(),
  rebaseBaselineScenario(),
  stagingAddScenario(),
  maintenanceReachabilityScenario(),
  packFallbackAuditScenario(),
  packAuthenticationScenario(),
  retainedGraphScenario(),
  objectSingletonScenario(),
  configMoveScenario(),
  checkoutListScenario(),
];
