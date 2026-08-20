// Synthetic trees: a fixed file size and a chosen fan-out, so file count is
// the only variable. Every scenario separates setup from the measured
// region — building the fixture is not part of the operation under test.

import {
  type Harness,
  type Scenario,
  type ScenarioContext,
  type Shape,
  shapeOf,
} from "./harness.js";

/** Fixed so file size is never an accidental variable. */
export const FILE_BYTES = 4096;
const FANOUT = 20;

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

/** One measured operation, the shape every synthetic scenario has. */
function only(name: string, run: (context: ScenarioContext) => Promise<void>): Scenario["phases"] {
  return [{ name, run }];
}

export const SYNTHETIC: Scenario[] = [
  {
    name: "add-commit",
    kind: "synthetic",
    async setup({ harness, count, variant }) {
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shapeOf(variant), count);
    },
    phases: only("add-commit", async ({ harness }) => {
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "bench" });
    }),
  },
  {
    name: "status-clean",
    kind: "synthetic",
    async setup({ harness, count, variant }) {
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shapeOf(variant), count);
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "bench" });
    },
    phases: only("status-clean", async ({ harness }) => {
      await harness.git.status({ dir: "/" });
    }),
  },
  {
    name: "status-dirty",
    kind: "synthetic",
    async setup({ harness, count, variant }) {
      const shape = shapeOf(variant);
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shape, count);
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "bench" });
      // A tenth of the tree changes, which is the shape of a real edit.
      await writeFiles(harness, shape, Math.max(1, Math.floor(count / 10)), "1");
    },
    phases: only("status-dirty", async ({ harness }) => {
      await harness.git.status({ dir: "/" });
    }),
  },
  {
    name: "checkout",
    kind: "synthetic",
    async setup({ harness, count, variant }) {
      const shape = shapeOf(variant);
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shape, count);
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "first" });
      await harness.git.branch({ dir: "/", name: "other" });
      await writeFiles(harness, shape, count, "1");
      await harness.git.add({ dir: "/", paths: ["."] });
      await harness.git.commit({ dir: "/", message: "second" });
    },
    phases: only("checkout", async ({ harness }) => {
      await harness.git.checkout({ dir: "/", ref: "other" });
    }),
  },
  {
    name: "log",
    kind: "synthetic",
    async setup({ harness, count, variant }) {
      await harness.git.init({ dir: "/" });
      await writeFiles(harness, shapeOf(variant), Math.min(count, 50));
      await harness.git.add({ dir: "/", paths: ["."] });
      // History length is the variable here, not the tree.
      for (let i = 0; i < Math.max(1, Math.floor(count / 10)); i++) {
        await harness.workspace.fs.writeFile("/tip.txt", `revision ${i}`);
        await harness.git.add({ dir: "/", paths: ["tip.txt"] });
        await harness.git.commit({ dir: "/", message: `commit ${i}` });
      }
    },
    phases: only("log", async ({ harness }) => {
      await harness.git.log({ dir: "/" });
    }),
  },
];
