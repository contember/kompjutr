// Random op sequences. Generation is online: each op is drawn from the state
// the previous ops actually produced (read from the git side, which equals
// kompjutr's until the first divergence), so a sequence stays plausible —
// edits hit tracked files, merges name real branches, a paused integration
// gets resolved. The recorded sequence is plain data and replays without the
// generator, which is what shrinking relies on.

import type { Content, Op, WorldStart } from "./ops.js";
import type { Snapshot } from "./snapshot.js";

/** mulberry32: small, fast, and identical on every platform. */
export class Random {
  #state: number;
  constructor(seed: number) {
    this.#state = seed >>> 0;
  }
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }
  int(bound: number): number {
    return Math.floor(this.next() * bound);
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }
}

/**
 * Paths chosen to stress what Git gets subtly right: deep trees, non-ASCII
 * names, names ordered differently in UTF-16 and UTF-8 (U+FF61 sorts before
 * U+1F600 in UTF-16 and after it in UTF-8), file/directory collisions
 * (`x` and `x/y`), and the `a.b` / `a/b` / `a-b` tree-order trap.
 */
const PATHS = [
  "a.txt",
  "b.txt",
  "c.bin",
  "dir/x.txt",
  "dir/y.txt",
  "dir/sub/z.txt",
  "deep/1/2/3/4/5/6/7/leaf.txt",
  "ü/ñ.txt",
  "日本語.md",
  "\u{1F600}.txt",
  "｡.txt",
  "spaced name.txt",
  "x",
  "x/y",
  "a.b",
  "a/b",
  "a-b",
  "README.md",
];
const BRANCHES = ["main", "feature", "topic", "fix/one", "ü-branch", "release-1"];
const TAGS = ["v1", "v2", "rel/x"];
const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

export interface View {
  branches: string[];
  tags: string[];
  current: string | null;
  operation: Snapshot["operation"];
  tracked: string[];
  unmerged: string[];
  files: Map<string, string>;
}

export function viewOf(snapshot: Snapshot): View {
  const branches: string[] = [];
  const tags: string[] = [];
  for (const ref of snapshot.refs) {
    const name = ref.slice(0, ref.indexOf(" "));
    if (name.startsWith("refs/heads/")) branches.push(name.slice("refs/heads/".length));
    if (name.startsWith("refs/tags/")) tags.push(name.slice("refs/tags/".length));
  }
  const tracked = new Set<string>();
  const unmerged = new Set<string>();
  for (const row of snapshot.index) {
    const [meta = "", path = ""] = row.split("\t");
    tracked.add(path);
    if (!meta.endsWith(" 0")) unmerged.add(path);
  }
  const files = new Map<string, string>();
  for (const entry of snapshot.worktree) {
    if (entry.type === "file") files.set(entry.path, entry.content ?? "");
  }
  return {
    branches,
    tags,
    current: snapshot.branch?.replace(/^refs\/heads\//, "") ?? null,
    operation: snapshot.operation,
    tracked: [...tracked],
    unmerged: [...unmerged],
    files,
  };
}

type Weighted = [number, () => Op];

export class Generator {
  readonly #random: Random;
  readonly #network: boolean;
  #counter = 0;

  constructor(seed: number, start: WorldStart) {
    this.#random = new Random(seed);
    this.#network = start === "clone";
  }

  next(view: View): Op {
    this.#counter++;
    const choices = view.operation === null ? this.#ordinary(view) : this.#paused(view);
    const total = choices.reduce((sum, [weight]) => sum + weight, 0);
    let roll = this.#random.next() * total;
    for (const [weight, make] of choices) {
      roll -= weight;
      if (roll < 0) return make();
    }
    const last = choices[choices.length - 1];
    if (last === undefined) throw new Error("no op to choose from");
    return last[1]();
  }

  #ordinary(view: View): Weighted[] {
    const r = this.#random;
    const choices: Weighted[] = [
      [24, () => this.#write(view)],
      [3, () => ({ op: "remove", path: this.#existing(view) })],
      [1, () => ({ op: "symlink", path: this.#path(), target: r.pick(PATHS) })],
      [10, () => ({ op: "add", paths: this.#pathspecs(view) })],
      [6, () => ({ op: "addAll", ...(r.chance(0.3) ? { update: true } : {}) })],
      [3, () => this.#rm(view)],
      [2, () => ({ op: "mv", from: this.#tracked(view), to: this.#path() })],
      [14, () => this.#commit()],
      [3, () => this.#reset(view)],
      [1, () => ({ op: "clean", ...(r.chance(0.5) ? { directories: true } : {}) })],
      [5, () => ({ op: "branch", name: r.pick(BRANCHES), ...this.#maybeStart(view) })],
      [
        2,
        () => ({ op: "branchDelete", name: this.#branch(view), ...flag("force", r.chance(0.5)) }),
      ],
      [1, () => ({ op: "branchRename", from: this.#branch(view), to: r.pick(BRANCHES) })],
      [7, () => ({ op: "checkout", ref: this.#ref(view), ...flag("force", r.chance(0.15)) })],
      [3, () => ({ op: "checkoutNew", name: r.pick(BRANCHES), ...this.#maybeStart(view) })],
      [2, () => ({ op: "checkoutPaths", ref: this.#ref(view), paths: this.#pathspecs(view) })],
      [2, () => ({ op: "tag", name: r.pick(TAGS), ...this.#maybeObject(view) })],
      [1, () => ({ op: "tagDelete", name: r.pick(TAGS) })],
      [7, () => this.#merge(view)],
      [3, () => ({ op: "cherryPick", source: this.#ref(view) })],
      [2, () => ({ op: "revert", source: this.#ref(view) })],
      [4, () => ({ op: "rebase", upstream: this.#branch(view) })],
      [1, () => ({ op: "reopen" })],
      [1, () => ({ op: "maintenance" })],
    ];
    if (this.#network) {
      choices.push(
        [2, () => ({ op: "fetch", ...flag("prune", r.chance(0.3)) })],
        [3, () => this.#push(view)],
        [2, () => ({ op: "pull", message: this.#message(), ...this.#mergeMode() })],
        [3, () => this.#peer()],
      );
    }
    return choices;
  }

  /** An integration is paused: mostly resolve it, sometimes wander off. */
  #paused(view: View): Weighted[] {
    const r = this.#random;
    const kind = view.operation;
    const resolve = (): Op => {
      const path = view.unmerged.length > 0 ? r.pick(view.unmerged) : this.#existing(view);
      return { op: "write", path, content: this.#text() };
    };
    const choices: Weighted[] = [
      [20, resolve],
      [14, () => ({ op: "add", paths: view.unmerged.length > 0 ? view.unmerged : ["."] })],
      [3, () => ({ op: "rm", paths: [this.#unmergedOrTracked(view)], ...flag("force", true) })],
      [6, () => abortOf(kind)],
      [12, () => continueOf(kind, this.#message())],
      [4, () => this.#write(view)],
      [6, () => ({ op: "addAll" })],
    ];
    if (kind === "rebase") choices.push([4, () => ({ op: "rebaseSkip" })]);
    if (kind === "cherry-pick") choices.push([4, () => ({ op: "cherryPickSkip" })]);
    if (kind === "revert") choices.push([4, () => ({ op: "revertSkip" })]);
    if (kind === "merge") choices.push([3, () => this.#commit()]);
    // Anything else, rarely: refusals during a pause must match too.
    choices.push([3, () => this.#pickFrom(this.#ordinary(view))]);
    return choices;
  }

  #pickFrom(choices: Weighted[]): Op {
    return this.#random.pick(choices)[1]();
  }

  #write(view: View): Op {
    const r = this.#random;
    const known = [...view.files.keys()];
    if (known.length > 0 && r.chance(0.55)) {
      const path = r.pick(known);
      return {
        op: "write",
        path,
        content: this.#edit(view.files.get(path) ?? ""),
        ...flag("executable", r.chance(0.05)),
      };
    }
    const path = this.#path();
    const content: Content = r.chance(0.15) ? this.#binary() : this.#text();
    return { op: "write", path, content, ...flag("executable", r.chance(0.1)) };
  }

  /** Change one line of existing text, so branches touch the same files. */
  #edit(hex: string): Content {
    const r = this.#random;
    const lines = Buffer.from(hex, "hex").toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0 || r.chance(0.2)) lines.push(r.pick(WORDS));
    else lines[r.int(lines.length)] = `${r.pick(WORDS)} ${this.#counter}`;
    if (r.chance(0.1) && lines.length > 1) lines.splice(r.int(lines.length), 1);
    return { text: `${lines.join("\n")}\n` };
  }

  #text(): Content {
    const r = this.#random;
    const lines = Array.from({ length: 1 + r.int(5) }, () => r.pick(WORDS));
    if (r.chance(0.05)) return { text: "" };
    return { text: `${lines.join("\n")}${r.chance(0.9) ? "\n" : ""}` };
  }

  #binary(): Content {
    const r = this.#random;
    const bytes = Buffer.alloc(1 + r.int(48));
    for (let index = 0; index < bytes.length; index++) bytes[index] = r.int(256);
    bytes[0] = 0;
    return { hex: bytes.toString("hex") };
  }

  #commit(): Op {
    const r = this.#random;
    return {
      op: "commit",
      message: this.#message(),
      ...flag("all", r.chance(0.2)),
      ...flag("amend", r.chance(0.08)),
      ...flag("allowEmpty", r.chance(0.08)),
    };
  }

  #message(): string {
    const r = this.#random;
    const subject = `m${this.#counter}`;
    if (r.chance(0.1)) return `${subject} ü\n\nbody line\n`;
    if (r.chance(0.05)) return `${subject}  \n\n\n`;
    return subject;
  }

  #reset(view: View): Op {
    const r = this.#random;
    if (r.chance(0.3)) return { op: "reset", paths: this.#pathspecs(view) };
    const ref = r.chance(0.5) ? undefined : r.pick(["HEAD", "HEAD~1", this.#branch(view)]);
    return { op: "reset", ...(ref === undefined ? {} : { ref }), ...flag("hard", r.chance(0.5)) };
  }

  #rm(view: View): Op {
    const r = this.#random;
    const recursive = r.chance(0.3);
    const path = recursive ? r.pick(["dir", "deep", "ü", "x", "a"]) : this.#tracked(view);
    return {
      op: "rm",
      paths: [path],
      ...flag("cached", r.chance(0.4)),
      ...flag("recursive", recursive),
      ...flag("force", r.chance(0.3)),
    };
  }

  #merge(view: View): Op {
    const r = this.#random;
    return {
      op: "merge",
      theirs: this.#ref(view),
      message: this.#message(),
      ...this.#mergeMode(),
      ...flag("noCommit", r.chance(0.1)),
    };
  }

  #mergeMode(): { mode?: "no-ff" | "ff-only" } {
    const roll = this.#random.next();
    if (roll < 0.2) return { mode: "no-ff" };
    if (roll < 0.3) return { mode: "ff-only" };
    return {};
  }

  #push(view: View): Op {
    const r = this.#random;
    return {
      op: "push",
      ref: view.current !== null && r.chance(0.7) ? view.current : this.#branch(view),
      ...flag("force", r.chance(0.2)),
      ...flag("delete", r.chance(0.08)),
    };
  }

  #peer(): Op {
    const r = this.#random;
    return {
      op: "peerCommit",
      branch: r.pick(["main", "feature", "topic"]),
      path: r.pick(["README.md", "dir/x.txt", "peer.txt", "a.txt"]),
      content: this.#text(),
      message: `peer ${this.#counter}`,
    };
  }

  #path(): string {
    return this.#random.pick(PATHS);
  }

  #existing(view: View): string {
    const known = [...view.files.keys()];
    return known.length > 0 && this.#random.chance(0.8) ? this.#random.pick(known) : this.#path();
  }

  #tracked(view: View): string {
    return view.tracked.length > 0 && this.#random.chance(0.85)
      ? this.#random.pick(view.tracked)
      : this.#path();
  }

  #unmergedOrTracked(view: View): string {
    return view.unmerged.length > 0 ? this.#random.pick(view.unmerged) : this.#tracked(view);
  }

  #pathspecs(view: View): string[] {
    const r = this.#random;
    if (r.chance(0.15)) return ["."];
    if (r.chance(0.1)) return [r.pick(["dir", "deep", "*.txt", "ü"])];
    const known = [...view.files.keys(), ...view.tracked];
    const first = known.length > 0 && r.chance(0.85) ? r.pick(known) : this.#path();
    return r.chance(0.2) ? [first, this.#existing(view)] : [first];
  }

  #branch(view: View): string {
    return view.branches.length > 0 && this.#random.chance(0.9)
      ? this.#random.pick(view.branches)
      : this.#random.pick(BRANCHES);
  }

  /** A branch, a tag, an ancestor, or a remote-tracking branch. */
  #ref(view: View): string {
    const r = this.#random;
    const roll = r.next();
    if (roll < 0.6) return this.#branch(view);
    if (roll < 0.7 && view.tags.length > 0) return r.pick(view.tags);
    if (roll < 0.8 && this.#network) return `origin/${r.pick(["main", "feature", "topic"])}`;
    if (roll < 0.9) return `${this.#branch(view)}~1`;
    return r.pick(["HEAD~1", "HEAD^", "HEAD~2"]);
  }

  #maybeStart(view: View): { startPoint?: string } {
    return this.#random.chance(0.5) ? { startPoint: this.#ref(view) } : {};
  }

  #maybeObject(view: View): { object?: string } {
    return this.#random.chance(0.4) ? { object: this.#ref(view) } : {};
  }
}

function flag<K extends string>(key: K, on: boolean): Partial<Record<K, true>> {
  if (!on) return {};
  const result: Partial<Record<K, true>> = {};
  result[key] = true;
  return result;
}

function abortOf(kind: View["operation"]): Op {
  if (kind === "rebase") return { op: "rebaseAbort" };
  if (kind === "cherry-pick") return { op: "cherryPickAbort" };
  if (kind === "revert") return { op: "revertAbort" };
  return { op: "mergeAbort" };
}

function continueOf(kind: View["operation"], message: string): Op {
  if (kind === "rebase") return { op: "rebaseContinue" };
  if (kind === "cherry-pick") return { op: "cherryPickContinue" };
  if (kind === "revert") return { op: "revertContinue" };
  return { op: "mergeContinue", message };
}
