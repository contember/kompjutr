import { createHash } from "node:crypto";
import { CHUNK_SIZE } from "../src/fs/schema.js";
import { createInitialWorktreeWriter } from "../src/fs/store/initial-write.js";
import type { Filesystem } from "../src/fs/types.js";
import { MemoryCoordinator } from "../src/memory.js";
import type { Scenario } from "./harness.js";
import { type MemoryPhaseEvidence, memoryScenarioSpec } from "./memory-protocol.js";

const INITIAL_SPEC = memoryScenarioSpec("fs.initial-write");
const REDIRECT_SPEC = memoryScenarioSpec("fs.redirect.stream");
const INITIAL_SYMLINK_BYTES = 64 * 1024 + 1;
const INITIAL_PATTERN_SEED = 0xa5;
const REDIRECT_PATTERN_SEED = 0x5a;

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
  let coordinatorHighWaterBytes: number | null = null;
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
          const coordinator = new MemoryCoordinator();
          const root = coordinator.reserve();
          try {
            const result = createInitialWorktreeWriter(
              harness.workspace.filesystem.db,
              () => 1_577_836_800_000,
            ).tryRun(
              "/repo",
              (session) => {
                session.writeSymlink("large-link", target);
                session.writeFileStream(
                  "z-stream.bin",
                  INITIAL_SPEC.verifiedContentBytes,
                  patternedChunks(INITIAL_SPEC.verifiedContentBytes, INITIAL_PATTERN_SEED),
                );
              },
              undefined,
              root,
            );
            if (result.kind !== "committed") throw new Error("initial writer was unavailable");
            if (root.currentBytes !== 0) {
              throw new Error("initial writer retained memory after completion");
            }
          } finally {
            coordinatorHighWaterBytes = coordinator.highWaterBytes;
            root.dispose();
            coordinator.assertIdle();
          }
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
          if (coordinatorHighWaterBytes === null || verificationDigest === null) {
            throw new Error("initial writer did not publish complete evidence");
          }
          return {
            source: INITIAL_SPEC.source,
            workloadBytes: INITIAL_SPEC.workloadBytes,
            formerLimitBytes: INITIAL_SPEC.formerLimitBytes,
            verifiedContentBytes: INITIAL_SPEC.verifiedContentBytes,
            verifiedChunkCount: INITIAL_SPEC.verifiedChunkCount,
            verificationDigest,
            coordinatorHighWaterBytes,
            coordinatorFinalBytes: 0,
            coordinatorActiveReservations: 0,
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
            coordinatorHighWaterBytes: null,
            coordinatorFinalBytes: null,
            coordinatorActiveReservations: null,
          };
        },
      },
    ],
  };
}

export const MEMORY: Scenario[] = [initialWriteScenario(), redirectStreamScenario()];
