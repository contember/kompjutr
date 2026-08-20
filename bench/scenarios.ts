// What gets measured. Every scenario separates setup from the measured
// region: building the fixture is not part of the operation under test.

import { Workspace } from "@cloudflare/computer";
import type { GitClient, GitClientFactory } from "@cloudflare/computer/git";
import { createGitClient } from "@cloudflare/computer/git";

import { createSqliteGitClient } from "../src/index.js";
import { SqliteTestStorage } from "../tests/helpers/storage.js";

export type Backend = "dofs" | "sqlite";
/** Flat puts every file in one directory; deep fans out, 20 per directory. */
export type Shape = "flat" | "deep";

export interface Harness {
  git: GitClient;
  workspace: Workspace;
  storage: SqliteTestStorage;
}

const IDENTITY = { name: "Bench", email: "bench@example.com" };
/** Fixed so file size is never an accidental variable. */
export const FILE_BYTES = 4096;
const FANOUT = 20;

export function harness(backend: Backend): Harness {
  const factory: GitClientFactory =
    backend === "dofs" ? createGitClient() : createSqliteGitClient();
  const storage = new SqliteTestStorage();
  const now = (): number => 1_577_836_800_000;
  const workspace = new Workspace({ storage, now, git: factory });
  return { git: factory({ ws: workspace, defaultIdentity: IDENTITY }), workspace, storage };
}

export function pathFor(shape: Shape, index: number): string {
  return shape === "flat" ? `/f${index}.txt` : `/d${Math.floor(index / FANOUT)}/f${index}.txt`;
}

const BODY = "x".repeat(FILE_BYTES - 8);

export async function writeFiles(
  harness: Harness,
  shape: Shape,
  count: number,
  salt = "0",
): Promise<void> {
  const made = new Set<string>();
  for (let i = 0; i < count; i++) {
    const path = pathFor(shape, i);
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir !== "" && !made.has(dir)) {
      await harness.workspace.fs.mkdir(dir, { recursive: true });
      made.add(dir);
    }
    await harness.workspace.fs.writeFile(path, `${BODY}${salt}${String(i).padStart(6, "0")}`);
  }
}

export interface ScenarioContext {
  harness: Harness;
  count: number;
  shape: Shape;
}

export interface Scenario {
  name: string;
  /** Builds the fixture. Not measured. */
  setup(context: ScenarioContext): Promise<void>;
  /** The region that is measured. */
  run(context: ScenarioContext): Promise<void>;
}

export const SCENARIOS: Scenario[] = [
  {
    name: "add-commit",
    async setup({ harness, count, shape }) {
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shape, count);
    },
    async run({ harness }) {
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "bench" });
    },
  },
  {
    name: "status-clean",
    async setup({ harness, count, shape }) {
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shape, count);
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "bench" });
    },
    async run({ harness }) {
      await harness.git.status({ dir: "/" });
    },
  },
  {
    name: "status-dirty",
    async setup({ harness, count, shape }) {
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shape, count);
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "bench" });
      // A tenth of the tree changes, which is the shape of a real edit.
      await writeFiles(harness, shape, Math.max(1, Math.floor(count / 10)), "1");
    },
    async run({ harness }) {
      await harness.git.status({ dir: "/" });
    },
  },
  {
    name: "checkout",
    async setup({ harness, count, shape }) {
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shape, count);
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "first" });
      await harness.git.branch({ dir: "/", name: "other" });
      await writeFiles(harness, shape, count, "1");
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "second" });
    },
    async run({ harness }) {
      await harness.git.checkout({ dir: "/", ref: "other" });
    },
  },
  {
    name: "log",
    async setup({ harness, count, shape }) {
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shape, Math.min(count, 50));
      await harness.git.add({ dir: "/", paths: ["."] });
      // History length is the variable here, not the tree.
      for (let i = 0; i < Math.max(1, Math.floor(count / 10)); i++) {
        await harness.workspace.fs.writeFile("/tip.txt", `revision ${i}`);
        await harness.git.add({ dir: "/", paths: ["tip.txt"] });
        await harness.git.commit({ dir: "/", message: `commit ${i}` });
      }
    },
    async run({ harness }) {
      await harness.git.log({ dir: "/" });
    },
  },
];
