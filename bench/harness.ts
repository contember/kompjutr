// The two clients under test, and the shape every scenario is written to.
//
// A scenario is a fixture plus an ordered list of measured phases. One
// process runs one scenario, so a phase never pays for a previous
// scenario's allocations; phases inside a scenario share the fixture, which
// is what makes a six-operation macro suite affordable.

import { Workspace } from "@cloudflare/computer";
import type { GitClient, GitClientFactory } from "@cloudflare/computer/git";
import { createGitClient } from "@cloudflare/computer/git";

import { createSqliteGitClient } from "../src/index.js";
import { SqliteTestStorage } from "../tests/helpers/storage.js";
import { type FixtureName, isFixtureName } from "./fixtures.js";

export type Backend = "dofs" | "sqlite";
/** Flat puts every file in one directory; deep fans out, 20 per directory. */
export type Shape = "flat" | "deep";
/** What the cell varies: a synthetic tree shape, or a real repository. */
export type Variant = Shape | FixtureName;

export interface Harness {
  git: GitClient;
  workspace: Workspace;
  storage: SqliteTestStorage;
}

const IDENTITY = { name: "Bench", email: "bench@example.com" };

export function harness(backend: Backend): Harness {
  const factory: GitClientFactory =
    backend === "dofs" ? createGitClient() : createSqliteGitClient();
  const storage = new SqliteTestStorage();
  const now = (): number => 1_577_836_800_000;
  const workspace = new Workspace({ storage, now, git: factory });
  return { git: factory({ ws: workspace, defaultIdentity: IDENTITY }), workspace, storage };
}

export interface ScenarioContext {
  harness: Harness;
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
}

export interface Scenario {
  name: string;
  kind: "synthetic" | "macro";
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
