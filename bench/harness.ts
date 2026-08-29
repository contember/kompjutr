// The runtime under test, and the shape every scenario is written to.
//
// A scenario is a fixture plus an ordered list of measured phases. One
// process runs one scenario, so a phase never pays for a previous
// scenario's allocations; phases inside a scenario share the fixture, which
// is what makes a six-operation macro suite affordable.

import { createGit, type Git, Workspace } from "../src/index.js";
import { SqliteTestStorage } from "../tests/helpers/storage.js";
import { type FixtureName, isFixtureName } from "./fixtures.js";
import type { MemoryPhaseEvidence } from "./memory-protocol.js";

export type Backend = "sqlite";
/** Flat puts every file in one directory; deep fans out, 20 per directory. */
export type Shape = "flat" | "deep";
/** What the cell varies: a synthetic tree shape, or a real repository. */
export type Variant = Shape | FixtureName;

export interface Harness {
  git: Git;
  workspace: Workspace;
  storage: SqliteTestStorage;
}

const IDENTITY = { name: "Bench", email: "bench@example.com" };

export function harness(_backend: Backend, databasePath = ":memory:"): Harness {
  const storage = new SqliteTestStorage(databasePath);
  const now = (): number => 1_577_836_800_000;
  const workspace = new Workspace({
    storage,
    now,
    git: createGit(),
    defaultGitIdentity: IDENTITY,
  });
  return { git: workspace.git, workspace, storage };
}

export interface ScenarioContext {
  harness: Harness;
  /** File-backed SQLite path for memory scenarios; null for ordinary cells. */
  databasePath: string | null;
  /** Files for a synthetic tree; a cap on tracked files for a fixture, 0 for all. */
  count: number;
  variant: Variant;
}

export interface Phase {
  /** The operation label. Matched against the reference report's rows. */
  name: string;
  /** Brings the tree to this phase's starting state. Not measured. */
  before?(context: ScenarioContext): Promise<void>;
  /** The region that is measured. */
  run(context: ScenarioContext): Promise<void>;
  /** Strong end-state verification. Runs after the memory peak is captured. */
  verify?(context: ScenarioContext): Promise<void>;
  /** Memory-owner evidence captured by the measured operation. */
  memoryEvidence?(): MemoryPhaseEvidence;
}

export interface Scenario {
  name: string;
  kind: "synthetic" | "macro" | "memory";
  /** Keep SQLite pages and WAL bytes outside the Node heap for cgroup evidence. */
  fileBacked?: boolean;
  /** Builds the fixture. Not measured. */
  setup(context: ScenarioContext): Promise<void>;
  phases: Phase[];
  teardown?(context: ScenarioContext): Promise<void>;
}

export function isShape(value: string): value is Shape {
  return value === "flat" || value === "deep";
}

export function asVariant(value: string | undefined): Variant {
  if (value !== undefined && (isShape(value) || isFixtureName(value))) return value;
  throw new Error(`unknown variant: ${String(value)}`);
}

/** Synthetic scenarios only ever run against a tree shape. */
export function shapeOf(variant: Variant): Shape {
  if (isShape(variant)) return variant;
  throw new Error(`${variant} is a repository fixture, not a tree shape`);
}

export function fixtureNameOf(variant: Variant): FixtureName {
  if (isFixtureName(variant)) return variant;
  throw new Error(`${variant} is a tree shape, not a repository fixture`);
}
