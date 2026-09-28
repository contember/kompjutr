// `-exec`, through the `invoke` seam that `xargs` also uses. The command
// shares find's `BoundedFs`, so every invocation counts against the same
// operation ceiling.
//
// `-exec … ;` runs once per path and is a test: true when the command exits
// 0. `-exec … {} +` gathers paths and runs when a batch is full or the walk
// ends; it is always true, and a failed batch makes find exit 1.

import { close, encode } from "../../exec/bytes.js";
import type { CommandContext } from "../../exec/context.js";
import type { Expression } from "./types.js";

/** GNU's default command buffer: every argument's bytes plus its NUL. */
const BATCH_BYTES = 131_072;
/** The shell's expanded-argv ceiling, which a batch must fit as a whole. */
const BATCH_ARGUMENTS = 10_000;

type ExecNode = Extract<Expression, { readonly kind: "exec" }>;

interface Batch {
  readonly argv: readonly string[];
  readonly fixedBytes: number;
  paths: string[];
  bytes: number;
  releases: Array<() => void>;
}

export class ExecRunner {
  #failed = false;
  #truncated = false;
  readonly #batches = new Map<ExecNode, Batch>();

  /**
   * `beforeRun` settles work find still holds — queued deletions — so the
   * command sees the tree GNU's command would see.
   */
  constructor(
    private readonly context: CommandContext,
    execNodes: Iterable<ExecNode>,
    private readonly beforeRun: () => void,
  ) {
    // Pending batches run at the end in expression order, as GNU's do.
    for (const node of execNodes) {
      if (!node.batched) continue;
      this.#batches.set(node, {
        argv: node.argv,
        fixedBytes: node.argv.reduce((total, part) => total + byteLength(part) + 1, 0),
        paths: [],
        bytes: 0,
        releases: [],
      });
    }
  }

  /** True when any `-exec … +` invocation failed. */
  get failed(): boolean {
    return this.#failed;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  async *each(
    argv: readonly string[],
    display: string,
  ): AsyncGenerator<Uint8Array, boolean, undefined> {
    const substituted = argv.map((part) => part.split("{}").join(display));
    return (yield* this.#run(substituted)) === 0;
  }

  /** Adds a path to its batch, running the batch first when the path would not fit. */
  async *queue(node: ExecNode, display: string): AsyncGenerator<Uint8Array, boolean, undefined> {
    const batch = this.#batches.get(node);
    if (batch === undefined) throw new Error("find: -exec + batch was not registered");
    const bytes = byteLength(display) + 1;
    const full =
      batch.fixedBytes + batch.bytes + bytes > BATCH_BYTES ||
      batch.argv.length + batch.paths.length + 1 > BATCH_ARGUMENTS;
    if (batch.paths.length > 0 && full) yield* this.#runBatch(batch);
    batch.releases.push(this.context.fs.retained.retain(display.length * 2, "find -exec batch"));
    batch.paths.push(display);
    batch.bytes += bytes;
    return true;
  }

  /** Runs every pending batch. */
  async *finish(): AsyncGenerator<Uint8Array, void, undefined> {
    for (const batch of this.#batches.values()) {
      if (batch.paths.length > 0) yield* this.#runBatch(batch);
    }
  }

  /** Releases what unrun batches hold, for a walk that ended early. */
  release(): void {
    for (const batch of this.#batches.values()) {
      for (const release of batch.releases) release();
      batch.releases = [];
    }
  }

  async *#runBatch(batch: Batch): AsyncGenerator<Uint8Array, void, undefined> {
    const argv = [...batch.argv, ...batch.paths];
    for (const release of batch.releases) release();
    batch.paths = [];
    batch.bytes = 0;
    batch.releases = [];
    if ((yield* this.#run(argv)) !== 0) this.#failed = true;
  }

  async *#run(argv: readonly string[]): AsyncGenerator<Uint8Array, number, undefined> {
    const [name = "", ...rest] = argv;
    this.beforeRun();
    const produced = await this.context.invoke(name, rest);
    if (produced === null) {
      this.context.warn(`'${name}': No such file or directory`);
      return 127;
    }
    try {
      for (;;) {
        const next = await produced.stdout.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      await close(produced.stdout);
      this.#truncated ||= produced.truncated?.() ?? false;
    }
    return produced.status();
  }
}

function byteLength(text: string): number {
  return encode(text).length;
}
