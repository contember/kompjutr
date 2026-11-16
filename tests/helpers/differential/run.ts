// Play a scenario on both sides and stop at the first divergence; generate
// one online from a seed; shrink a failing one to a minimal repro.

import { Generator, viewOf } from "./generate.js";
import { knownDivergence } from "./known.js";
import { describeScenario, type Op, type Scenario, type WorldStart } from "./ops.js";
import {
  compareSnapshots,
  type Snapshot,
  type StateDifference,
  snapshotGit,
  snapshotKompjutr,
} from "./snapshot.js";
import { createWorld, type DifferentialWorld, type Outcome } from "./world.js";

export interface Divergence {
  /** Zero-based index of the op after which the sides disagreed. */
  step: number;
  op: Op;
  /** The ops played before `op`, oldest first. */
  before: Op[];
  /** git's state before `op`, which both sides still agreed on. */
  prior: Snapshot;
  outcomes: { kompjutr: Outcome; git: Outcome };
  /** `outcome`, `crash`, or the first differing snapshot field. */
  field: string;
  /** Every differing field; a known divergence must explain all of them. */
  fields: string[];
  kompjutr: unknown;
  git: unknown;
  /** Each differing snapshot field with both values; empty for an outcome. */
  differences: StateDifference[];
  /** Both states after `op`; null when the outcomes already differed. */
  after: { kompjutr: Snapshot; git: Snapshot } | null;
}

export interface PlayResult {
  scenario: Scenario;
  divergence: Divergence | null;
}

type Step = { divergence: Divergence } | { divergence: null; after: Snapshot };

async function step(
  world: DifferentialWorld,
  ops: Op[],
  index: number,
  prior: Snapshot,
): Promise<Step> {
  const op = ops[index];
  if (op === undefined) throw new Error(`no op at ${index}`);
  const kompjutr: Outcome = await world.applyKompjutr(op);
  const git = world.applyGit(op);
  const at = {
    step: index,
    op,
    before: ops.slice(0, index),
    prior,
    outcomes: { kompjutr, git },
    differences: [],
    after: null,
  };
  if (kompjutr.crash === true) {
    const divergence = { ...at, field: "crash", fields: ["crash"], kompjutr: kompjutr.detail, git };
    return { divergence };
  }
  if (kompjutr.kind !== git.kind) {
    return { divergence: { ...at, field: "outcome", fields: ["outcome"], kompjutr, git } };
  }
  const origin = world.origins;
  const left = await snapshotKompjutr(world.workspace, world.root, origin?.kompjutr ?? null);
  const right = gitSnapshot(world);
  const differences = compareSnapshots(left, right);
  const first = differences[0];
  if (first === undefined) return { divergence: null, after: right };
  const divergence = {
    ...at,
    field: first.field,
    fields: differences.map((difference) => difference.field),
    kompjutr: first.kompjutr,
    git: first.git,
    differences,
    after: { kompjutr: left, git: right },
  };
  return { divergence };
}

function gitSnapshot(world: DifferentialWorld): Snapshot {
  return snapshotGit(world.mirror, world.origins?.git ?? null);
}

/** Replay a fixed op list. */
export async function play(scenario: Scenario): Promise<Divergence | null> {
  const world = await createWorld(scenario.start);
  try {
    let prior = gitSnapshot(world);
    for (let index = 0; index < scenario.ops.length; index++) {
      const result = await step(world, scenario.ops, index, prior);
      if (result.divergence !== null) return result.divergence;
      prior = result.after;
    }
    return null;
  } finally {
    await world.dispose();
  }
}

export function startFor(seed: number): WorldStart {
  return seed % 3 === 0 ? "clone" : "init";
}

/** Generate `length` ops from `seed`, each drawn from the state so far. */
export async function explore(seed: number, length: number): Promise<PlayResult> {
  const start = startFor(seed);
  const generator = new Generator(seed, start);
  const world = await createWorld(start);
  const ops: Op[] = [];
  try {
    let prior = gitSnapshot(world);
    for (let index = 0; index < length; index++) {
      const op = generator.next(viewOf(prior));
      ops.push(op);
      const result = await step(world, ops, index, prior);
      if (result.divergence !== null) {
        return { scenario: { start, ops }, divergence: result.divergence };
      }
      prior = result.after;
    }
    return { scenario: { start, ops }, divergence: null };
  } finally {
    await world.dispose();
  }
}

/**
 * The same op, the same differing fields, and for an outcome the same kinds
 * and kompjutr error code: a different defect must not stand in for this one.
 */
function signature(divergence: Divergence): string {
  const { kompjutr, git } = divergence.outcomes;
  const code = (kompjutr.detail ?? "").split(":")[0] ?? "";
  const outcome = divergence.field === "outcome" ? `${kompjutr.kind}/${git.kind}/${code}` : "";
  return `${divergence.op.op}:${divergence.fields.join(",")}:${outcome}`;
}

function label(divergence: Divergence): string {
  return `${divergence.op.op}:${divergence.field}`;
}

/**
 * A candidate reproduces when it fails the same way and is still unexplained:
 * a candidate that drifts into a known divergence is a different failure. A
 * harness fault in a candidate is not the failure being shrunk either.
 */
async function reproduces(scenario: Scenario, wanted: string): Promise<Divergence | null> {
  try {
    const divergence = await play(scenario);
    if (divergence === null || signature(divergence) !== wanted) return null;
    return knownDivergence(divergence) === undefined ? divergence : null;
  } catch {
    return null;
  }
}

/**
 * Delta debugging over the op list, then over each op's optional fields and
 * contents, keeping a candidate only while it fails the same way: the same
 * op kind diverging on the same field. Repeats until a pass changes nothing,
 * so a simplification can unlock further removals. Stops at `deadline` with
 * the best so far.
 */
export async function shrink(failed: PlayResult, deadline: number): Promise<PlayResult> {
  const first = failed.divergence;
  if (first === null) return failed;
  const wanted = signature(first);
  let best: Scenario = { ...failed.scenario, ops: failed.scenario.ops.slice(0, first.step + 1) };
  let divergence: Divergence = first;
  const attempt = async (candidate: Scenario): Promise<boolean> => {
    if (Date.now() > deadline) return false;
    const found = await reproduces(candidate, wanted);
    if (found === null) return false;
    best = { ...candidate, ops: candidate.ops.slice(0, found.step + 1) };
    divergence = found;
    return true;
  };

  let changed = true;
  while (changed && Date.now() < deadline) {
    changed = false;
    if (best.start === "clone" && !best.ops.some(needsNetwork)) {
      changed = (await attempt({ ...best, start: "init" })) || changed;
    }
    for (
      let size = Math.max(1, Math.floor(best.ops.length / 2));
      size >= 1;
      size = Math.floor(size / 2)
    ) {
      let index = 0;
      while (index < best.ops.length - 1 && Date.now() < deadline) {
        const ops = [...best.ops.slice(0, index), ...best.ops.slice(index + size)];
        if (ops.length > 0 && (await attempt({ ...best, ops }))) changed = true;
        else index += size;
      }
    }
    for (let index = 0; index < best.ops.length && Date.now() < deadline; index++) {
      let simplified = true;
      while (simplified) {
        simplified = false;
        for (const simpler of simplifications(best.ops[index])) {
          const ops = [...best.ops];
          ops[index] = simpler;
          if (await attempt({ ...best, ops })) {
            changed = true;
            simplified = true;
            break;
          }
        }
      }
    }
  }
  return { scenario: best, divergence };
}

function needsNetwork(op: Op): boolean {
  return (
    ["fetch", "push", "pull", "peerCommit"].includes(op.op) ||
    JSON.stringify(op).includes("origin/")
  );
}

/** Each optional field dropped, and file contents cut to one short line. */
function simplifications(op: Op | undefined): Op[] {
  if (op === undefined) return [];
  const out: Op[] = [];
  if (op.op === "write") {
    out.push({ ...op, content: { text: "x\n" } });
    if (op.executable === true) out.push({ op: "write", path: op.path, content: op.content });
  }
  if ("message" in op && op.message !== "m") out.push({ ...op, message: "m" });
  if (op.op === "commit") {
    const { amend: _amend, ...noAmend } = op;
    const { all: _all, ...noAll } = op;
    const { allowEmpty: _empty, ...noEmpty } = op;
    out.push(noAmend, noAll, noEmpty);
  }
  if ((op.op === "add" || op.op === "rm" || op.op === "checkoutPaths") && op.paths.length > 1) {
    for (const path of op.paths) out.push({ ...op, paths: [path] });
  }
  return out.filter((candidate) => JSON.stringify(candidate) !== JSON.stringify(op));
}

export function report(seed: number, original: PlayResult, shrunk: PlayResult): string {
  const divergence = shrunk.divergence;
  if (divergence === null) return `seed ${seed}: no divergence`;
  return [
    `seed ${seed}: kompjutr diverged from git on ${label(divergence)} at step ${divergence.step + 1}`,
    `(${original.scenario.ops.length} generated ops shrunk to ${shrunk.scenario.ops.length})`,
    describeScenario(shrunk.scenario),
    `differing: ${divergence.fields.join(", ")}`,
    ...(divergence.differences.length === 0
      ? [
          `kompjutr: ${JSON.stringify(divergence.kompjutr, null, 1)}`,
          `git:      ${JSON.stringify(divergence.git, null, 1)}`,
        ]
      : divergence.differences.flatMap((difference) => [
          `${difference.field} kompjutr: ${JSON.stringify(difference.kompjutr, null, 1)}`,
          `${difference.field} git:      ${JSON.stringify(difference.git, null, 1)}`,
        ])),
    `replay:   ${JSON.stringify(shrunk.scenario)}`,
  ].join("\n");
}

/** Fail with the divergence when the scenario does not play identically. */
export async function expectAgreement(scenario: Scenario): Promise<void> {
  const divergence = await play(scenario);
  if (divergence !== null) {
    const { prior: _prior, after: _after, ...shown } = divergence;
    throw new Error(`kompjutr diverged from git:\n${JSON.stringify(shown, null, 1)}`);
  }
}
