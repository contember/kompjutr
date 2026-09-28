import { existsSync } from "node:fs";

// Parses V8 `--trace-gc --trace-gc-verbose` output from workerd. A GC line gives
// heap used and committed before and after the collection; the verbose block that
// follows gives the post-GC external memory counter. V8 adds ArrayBuffer backing
// stores to that counter too, so "Backing store memory" is a part of it, not an
// addition. Every value is a sample at a GC event, so a peak is a lower bound.

const MIB = 1024 * 1024;
const KIB = 1024;

export const GC_TRACE_V8_FLAGS = ["--trace-gc", "--trace-gc-verbose", "--expose-gc"];

const LIBSTDBUF_CANDIDATES = [
  "/usr/libexec/coreutils/libstdbuf.so",
  "/usr/lib/coreutils/libstdbuf.so",
  "/usr/lib/x86_64-linux-gnu/coreutils/libstdbuf.so",
];

// V8 prints the trace through a block-buffered stdout pipe, and Miniflare stops
// workerd with SIGKILL, so an unflushed tail of the trace is lost. coreutils'
// stdbuf preload makes workerd's stdout line-buffered.
export function lineBufferedRuntimeEnv(): Record<string, string> {
  const library = LIBSTDBUF_CANDIDATES.find((candidate) => existsSync(candidate));
  if (library === undefined) {
    throw new Error("coreutils libstdbuf.so is required to line-buffer the workerd GC trace");
  }
  return { LD_PRELOAD: library, _STDBUF_O: "L" };
}

export interface GcEvent {
  isolate: string;
  forced: boolean;
  usedBeforeBytes: number;
  committedBeforeBytes: number;
  usedAfterBytes: number;
  committedAfterBytes: number;
  externalAfterBytes: number | null;
  arrayBufferAfterBytes: number | null;
}

export interface V8HeapSnapshot {
  usedBytes: number;
  committedBytes: number;
  externalBytes: number;
  arrayBufferBytes: number;
}

export interface V8CloneAttribution {
  isolate: string;
  gcEvents: number;
  samples: number;
  otherIsolateEvents: number;
  baseline: V8HeapSnapshot;
  final: V8HeapSnapshot;
  peakUsedBytes: number;
  peakCommittedBytes: number;
  peakExternalBytes: number;
  peakArrayBufferBytes: number;
  peakUsedPlusExternalBytes: number;
  peakCommittedPlusExternalBytes: number;
}

const GC_LINE =
  /^\[(\d+:0x[0-9a-f]+)\]\s+[\d.]+ ms: .+? ([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB, .*current mu = [\d.]+\) (.*)$/;
const GC_LINE_SHAPE = /^\[\d+:0x[0-9a-f]+\]\s+[\d.]+ ms: .* MB, /;
const EXTERNAL_LINE = /^\[(\d+:0x[0-9a-f]+)\] External memory reported:\s+(-?\d+) KB$/;
const BACKING_STORE_LINE = /^\[(\d+:0x[0-9a-f]+)\] Backing store memory:\s+(\d+) KB$/;

function megabytes(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid GC trace size ${value}`);
  return Math.round(parsed * MIB);
}

function kilobytes(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid GC trace size ${value}`);
  return Math.max(0, parsed) * KIB;
}

export class GcTrace {
  readonly events: GcEvent[] = [];
  readonly unparsed: string[] = [];
  #waiters: { count: number; resolve: () => void }[] = [];

  accept(message: string): boolean {
    for (const line of message.split("\n")) {
      if (!this.#acceptLine(line.trimEnd())) return false;
    }
    return true;
  }

  // Trace text arrives over a pipe after the request that caused it has returned.
  async waitForForced(count: number, timeoutMs: number): Promise<void> {
    if (this.#forcedComplete(count)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`forced GC ${count} did not reach the trace within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#waiters.push({
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  attributeBetweenForced(first: number, second: number): V8CloneAttribution {
    if (this.unparsed.length > 0) throw new Error(`unparsed GC trace line: ${this.unparsed[0]}`);
    const forced = this.events.filter((event) => event.forced);
    const start = forced[first - 1];
    const end = forced[second - 1];
    if (start === undefined || end === undefined) throw new Error("forced GC events are missing");
    const startIndex = this.events.indexOf(start);
    const endIndex = this.events.indexOf(end);
    const window = this.events.slice(startIndex + 1, endIndex + 1);
    const own = window.filter((event) => event.isolate === start.isolate);
    if (end.isolate !== start.isolate) throw new Error("forced GC events come from two isolates");
    let peakUsedBytes = 0;
    let peakCommittedBytes = 0;
    let peakExternalBytes = 0;
    let peakArrayBufferBytes = 0;
    let peakUsedPlusExternalBytes = 0;
    let peakCommittedPlusExternalBytes = 0;
    for (const event of own) {
      const external = requiredExternal(event);
      const committed = Math.max(event.committedBeforeBytes, event.committedAfterBytes);
      peakUsedBytes = Math.max(peakUsedBytes, event.usedBeforeBytes);
      peakCommittedBytes = Math.max(peakCommittedBytes, committed);
      peakExternalBytes = Math.max(peakExternalBytes, external.externalBytes);
      peakArrayBufferBytes = Math.max(peakArrayBufferBytes, external.arrayBufferBytes);
      // GC only releases external memory, so the post-GC counter is a lower bound
      // for the external memory that existed when the pre-GC heap was measured.
      peakUsedPlusExternalBytes = Math.max(
        peakUsedPlusExternalBytes,
        event.usedBeforeBytes + external.externalBytes,
      );
      peakCommittedPlusExternalBytes = Math.max(
        peakCommittedPlusExternalBytes,
        committed + external.externalBytes,
      );
    }
    return {
      isolate: start.isolate,
      gcEvents: own.length - 1,
      samples: own.length,
      otherIsolateEvents: window.length - own.length,
      baseline: afterSnapshot(start),
      final: afterSnapshot(end),
      peakUsedBytes,
      peakCommittedBytes,
      peakExternalBytes,
      peakArrayBufferBytes,
      peakUsedPlusExternalBytes,
      peakCommittedPlusExternalBytes,
    };
  }

  #acceptLine(line: string): boolean {
    const gc = GC_LINE.exec(line);
    if (gc === null && GC_LINE_SHAPE.test(line)) {
      this.unparsed.push(line);
      return true;
    }
    if (gc !== null) {
      // gc() collects with the "testing" reason; nothing else in the clone does.
      this.events.push({
        isolate: gc[1] ?? "",
        forced: (gc[6] ?? "").startsWith("testing"),
        usedBeforeBytes: megabytes(gc[2]),
        committedBeforeBytes: megabytes(gc[3]),
        usedAfterBytes: megabytes(gc[4]),
        committedAfterBytes: megabytes(gc[5]),
        externalAfterBytes: null,
        arrayBufferAfterBytes: null,
      });
      return true;
    }
    const external = EXTERNAL_LINE.exec(line);
    if (external !== null) {
      const event = this.#lastEvent(external[1]);
      if (event !== undefined) event.externalAfterBytes = kilobytes(external[2]);
      return true;
    }
    const backingStore = BACKING_STORE_LINE.exec(line);
    if (backingStore !== null) {
      const event = this.#lastEvent(backingStore[1]);
      if (event !== undefined) event.arrayBufferAfterBytes = kilobytes(backingStore[2]);
      this.#settle();
      return true;
    }
    return /^\[\d+:0x[0-9a-f]+(?::\d+)?\]/.test(line);
  }

  // A verbose block without a preceding GC line is left unattributed; the missing
  // values then fail attribution instead of the log handler.
  #lastEvent(isolate: string | undefined): GcEvent | undefined {
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index];
      if (event?.isolate === isolate) return event;
    }
    return undefined;
  }

  #forcedComplete(count: number): boolean {
    const event = this.events.filter((candidate) => candidate.forced)[count - 1];
    return event !== undefined && event.arrayBufferAfterBytes !== null;
  }

  #settle(): void {
    this.#waiters = this.#waiters.filter((waiter) => {
      if (!this.#forcedComplete(waiter.count)) return true;
      waiter.resolve();
      return false;
    });
  }
}

function requiredExternal(event: GcEvent): { externalBytes: number; arrayBufferBytes: number } {
  if (event.externalAfterBytes === null || event.arrayBufferAfterBytes === null) {
    throw new Error("GC trace has no verbose block; run with --trace-gc-verbose");
  }
  return { externalBytes: event.externalAfterBytes, arrayBufferBytes: event.arrayBufferAfterBytes };
}

function afterSnapshot(event: GcEvent): V8HeapSnapshot {
  const external = requiredExternal(event);
  return {
    usedBytes: event.usedAfterBytes,
    committedBytes: event.committedAfterBytes,
    externalBytes: external.externalBytes,
    arrayBufferBytes: external.arrayBufferBytes,
  };
}
