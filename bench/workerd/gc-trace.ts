import { execFileSync } from "node:child_process";

import { GC_DONE_MARKER, LIVE_SET_MARKER } from "./protocol.js";

// Parses V8 `--trace-gc --trace-gc-verbose` output from workerd. A GC line gives
// heap used and committed before and after the collection; the verbose block that
// follows gives the post-GC external memory counter. That counter already includes
// ArrayBuffer backing stores (and external strings), so "Backing store memory" is
// reported as a part of it, never added to it. Every value is a sample at a GC
// event, so a peak is a lower bound.

const MIB = 1024 * 1024;
const KIB = 1024;
const MAX_REPORTED_LINES = 5;
const LIVE_SET_LINE = new RegExp(`^${LIVE_SET_MARKER} (\\d+)$`);

export const GC_TRACE_V8_FLAGS = ["--trace-gc", "--trace-gc-verbose", "--expose-gc"];

// V8 prints the trace through a block-buffered stdout pipe, and Miniflare stops
// workerd with SIGKILL, so an unflushed tail of the trace is lost. stdbuf's preload
// makes workerd's stdout line-buffered; stdbuf itself would replace an inherited
// LD_PRELOAD, so its values are read out and the library is appended.
export function lineBufferedRuntimeEnv(): Record<string, string> {
  const { LD_PRELOAD: inherited, ...environment } = process.env;
  const [library, mode] = execFileSync("stdbuf", ["-oL", "printenv", "LD_PRELOAD", "_STDBUF_O"], {
    env: environment,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  if (library === undefined || library === "" || mode === undefined || mode === "") {
    throw new Error("stdbuf did not report its preload library");
  }
  const preload = inherited === undefined || inherited === "" ? library : `${inherited}:${library}`;
  return { LD_PRELOAD: preload, _STDBUF_O: mode };
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

export interface LiveSetPeak {
  samples: number;
  peakStatement: number;
  peakUsedBytes: number;
  peakExternalBytes: number;
  peakBytes: number;
}

interface LiveSetMarker {
  statement: number;
  eventCount: number;
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
  forcedEvents: number;
  samples: number;
  otherIsolateEvents: number;
  unrecognizedTraceLines: number;
  unrecognizedTraceSample: string[];
  baseline: V8HeapSnapshot;
  final: V8HeapSnapshot;
  peakUsedBytes: number;
  peakCommittedBytes: number;
  peakExternalBytes: number;
  peakArrayBufferBytes: number;
  peakUsedPlusExternalBytes: number;
  peakCommittedPlusExternalBytes: number;
}

const PREFIX = String.raw`\[(\d+:0x[0-9a-f]+)\]`;
const GC_LINE = new RegExp(
  String.raw`^${PREFIX}\s+[\d.]+ ms: .+? ([\d.]+) \(([\d.]+)\) -> ([\d.]+) \(([\d.]+)\) MB, .*current mu = [\d.]+\) (.*)$`,
);
const GC_LINE_SHAPE = /^\[\d+:0x[0-9a-f]+\]\s+[\d.]+ ms: .* MB, /;
const EXTERNAL_LINE = new RegExp(`^${PREFIX} External memory reported:\\s+(-?\\d+) KB$`);
const BACKING_STORE_LINE = new RegExp(`^${PREFIX} Backing store memory:\\s+(\\d+) KB$`);
const V8_PREFIXED = /^\[\d+:0x[0-9a-f]+(?::\d+)?\]/;
const KNOWN_VERBOSE_LINES = [
  /^\[\d+:0x[0-9a-f]+\] [A-Za-z -]+,\s+used:/,
  /^\[\d+:0x[0-9a-f]+\] Pool buffering /,
  /^\[\d+:0x[0-9a-f]+\] External memory global:/,
  /^\[\d+:0x[0-9a-f]+\] Total time spent in GC:/,
  /^\[\d+:0x[0-9a-f]+\] \(\*\) Sweeping is still in progress/,
  /^\[\d+:0x[0-9a-f]+\] Shrinking page /,
  /^\[\d+:0x[0-9a-f]+:\d+\]\s+[\d.]+ ms: \[(?:Heap|GlobalMemory)Controller\]/,
];

function megabytes(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid GC trace size ${value}`);
  return Math.round(parsed * MIB);
}

function kilobytes(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed * KIB : null;
}

export class GcTrace {
  readonly events: GcEvent[] = [];
  readonly #markers: number[] = [];
  readonly #liveSetMarkers: LiveSetMarker[] = [];
  readonly #rejected: string[] = [];
  readonly #unrecognized: string[] = [];
  #unrecognizedCount = 0;
  #waiters: { count: number; resolve: () => void }[] = [];

  accept(message: string): boolean {
    if (message.trim() === GC_DONE_MARKER) {
      this.#markers.push(this.events.length);
      this.#settle();
      return true;
    }
    const liveSet = LIVE_SET_LINE.exec(message.trim());
    if (liveSet !== null) {
      this.#liveSetMarkers.push({ statement: Number(liveSet[1]), eventCount: this.events.length });
      return true;
    }
    for (const line of message.split("\n")) {
      if (!this.#acceptLine(line.trimEnd())) return false;
    }
    return true;
  }

  // Trace text arrives over a pipe after the request that caused it has returned.
  async waitForMarker(count: number, timeoutMs: number): Promise<void> {
    if (this.#markers.length >= count) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`GC marker ${count} did not reach the trace within ${timeoutMs} ms`));
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

  attributeBetweenMarkers(first: number, second: number): V8CloneAttribution {
    if (this.#rejected.length > 0) throw new Error(`invalid GC trace line: ${this.#rejected[0]}`);
    const startIndex = this.#forcedBeforeMarker(first);
    const endIndex = this.#forcedBeforeMarker(second);
    const start = this.events[startIndex];
    const end = this.events[endIndex];
    if (start === undefined || end === undefined) throw new Error("forced GC events are missing");
    if (end.isolate !== start.isolate) throw new Error("forced GC events come from two isolates");
    const window = this.events.slice(startIndex + 1, endIndex + 1);
    const own = window.filter((event) => event.isolate === start.isolate);
    const organic = own.filter((event) => !event.forced);
    if (organic.length === 0) throw new Error("the measured region holds no unforced GC event");
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
      gcEvents: organic.length,
      forcedEvents: own.length - organic.length,
      samples: own.length,
      otherIsolateEvents: window.length - own.length,
      unrecognizedTraceLines: this.#unrecognizedCount,
      unrecognizedTraceSample: [...this.#unrecognized],
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

  // Each live-set marker follows forced GCs; the last one before it gives the
  // live heap and external memory at that statement.
  liveSetBetweenMarkers(first: number, second: number): LiveSetPeak {
    const lower = this.#markers[first - 1];
    const upper = this.#markers[second - 1];
    if (lower === undefined || upper === undefined) throw new Error("GC markers are missing");
    const isolate = this.events[this.#forcedBeforeMarker(first)]?.isolate;
    let previous = lower;
    let peak: Omit<LiveSetPeak, "samples"> | undefined;
    let samples = 0;
    for (const marker of this.#liveSetMarkers) {
      if (marker.eventCount <= lower || marker.eventCount > upper) continue;
      const event = this.#lastForced(isolate, previous, marker.eventCount);
      if (event === undefined) {
        throw new Error(
          `no forced GC precedes the live-set marker at statement ${marker.statement}`,
        );
      }
      previous = marker.eventCount;
      samples++;
      const external = requiredExternal(event);
      // The external counter also holds non-ArrayBuffer memory, and the backing
      // store counter runs a constant offset above it; neither contains the other.
      const externalBytes = Math.max(external.externalBytes, external.arrayBufferBytes);
      const bytes = event.usedAfterBytes + externalBytes;
      if (peak === undefined || bytes > peak.peakBytes) {
        peak = {
          peakStatement: marker.statement,
          peakUsedBytes: event.usedAfterBytes,
          peakExternalBytes: externalBytes,
          peakBytes: bytes,
        };
      }
    }
    if (peak === undefined) throw new Error("the measured region holds no live-set marker");
    return { samples, ...peak };
  }

  #lastForced(isolate: string | undefined, lower: number, bound: number): GcEvent | undefined {
    for (let index = bound - 1; index >= lower; index--) {
      const event = this.events[index];
      if (event?.forced === true && event.isolate === isolate) return event;
    }
    return undefined;
  }

  // One gc() call can log two forced collections (finishing incremental marking,
  // then the full GC); the last one before the marker is the settled state.
  #forcedBeforeMarker(marker: number): number {
    const bound = this.#markers[marker - 1];
    const lower = marker > 1 ? (this.#markers[marker - 2] ?? 0) : 0;
    if (bound === undefined) throw new Error(`GC marker ${marker} is missing`);
    for (let index = bound - 1; index >= lower; index--) {
      if (this.events[index]?.forced === true) return index;
    }
    throw new Error(`no forced GC precedes GC marker ${marker} in the trace`);
  }

  #acceptLine(line: string): boolean {
    const gc = GC_LINE.exec(line);
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
    if (GC_LINE_SHAPE.test(line)) {
      this.#rejected.push(line);
      return true;
    }
    const external = EXTERNAL_LINE.exec(line);
    if (external !== null) {
      this.#recordVerbose(line, external[1], kilobytes(external[2]), "externalAfterBytes");
      return true;
    }
    const backingStore = BACKING_STORE_LINE.exec(line);
    if (backingStore !== null) {
      this.#recordVerbose(
        line,
        backingStore[1],
        kilobytes(backingStore[2]),
        "arrayBufferAfterBytes",
      );
      return true;
    }
    if (!V8_PREFIXED.test(line)) return false;
    if (!KNOWN_VERBOSE_LINES.some((pattern) => pattern.test(line))) {
      this.#unrecognizedCount++;
      if (this.#unrecognized.length < MAX_REPORTED_LINES) this.#unrecognized.push(line);
    }
    return true;
  }

  // A detail line that cannot be attached or holds a negative counter is rejected;
  // attribution then fails instead of the log handler.
  #recordVerbose(
    line: string,
    isolate: string | undefined,
    bytes: number | null,
    field: "externalAfterBytes" | "arrayBufferAfterBytes",
  ): void {
    let event: GcEvent | undefined;
    for (let index = this.events.length - 1; index >= 0 && event === undefined; index--) {
      if (this.events[index]?.isolate === isolate) event = this.events[index];
    }
    if (event === undefined || bytes === null) {
      this.#rejected.push(line);
      return;
    }
    event[field] = bytes;
  }

  #settle(): void {
    this.#waiters = this.#waiters.filter((waiter) => {
      if (this.#markers.length < waiter.count) return true;
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
