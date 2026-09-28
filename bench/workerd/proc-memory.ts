import { readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface MemorySample {
  rssBytes: number;
  anonymousBytes: number;
  fileBytes: number;
}

export interface SampledPeaks {
  samples: number;
  intervalMs: number;
  samplingMs: number;
  peakRss: MemorySample;
  peakAnonymousBytes: number;
  peakFileBytes: number;
}

export interface WorkerdCgroup {
  path: string;
  memoryMaxBytes: number | null;
  memoryMaxSource: string | null;
}

export function workerdPid(): number {
  const children = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim();
  for (const field of children.split(/\s+/)) {
    if (field === "") continue;
    const pid = Number(field);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      if (readlinkSync(`/proc/${pid}/exe`).endsWith("/workerd")) return pid;
    } catch {
      // A short-lived child can exit while the process list is inspected.
    }
  }
  throw new Error("Miniflare workerd process was not found");
}

function kilobyteField(text: string, field: string, source: string): number {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(text);
  if (match === null) throw new Error(`${source} has no ${field}`);
  return Number(match[1]) * 1024;
}

export function statusBytes(pid: number, field: "VmRSS" | "VmHWM"): number {
  return kilobyteField(readFileSync(`/proc/${pid}/status`, "utf8"), field, `workerd ${pid} status`);
}

const PAGE_BYTES = 4096;

// Writing 5 to clear_refs resets VmHWM to the current RSS.
export function resetPeakRss(pid: number): void {
  writeFileSync(`/proc/${pid}/clear_refs`, "5");
  const peak = statusBytes(pid, "VmHWM");
  const current = statusBytes(pid, "VmRSS");
  if (Math.abs(peak - current) > PAGE_BYTES) {
    throw new Error(`VmHWM ${peak} did not reset to VmRSS ${current} for workerd ${pid}`);
  }
}

// The kernel's per-process counters. They cost microseconds to read, so they can
// be sampled often without slowing the clone.
export function statusSample(pid: number): MemorySample {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const source = `workerd ${pid} status`;
  return {
    rssBytes: kilobyteField(status, "VmRSS", source),
    anonymousBytes: kilobyteField(status, "RssAnon", source),
    fileBytes: kilobyteField(status, "RssFile", source) + kilobyteField(status, "RssShmem", source),
  };
}

// Walks every mapping under the mmap lock; about 13 ms on a 500 MiB workerd, so
// it brackets the clone instead of sampling it.
export function rollupSample(pid: number): MemorySample {
  const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
  const source = `workerd ${pid} smaps_rollup`;
  const rssBytes = kilobyteField(rollup, "Rss", source);
  const anonymousBytes = kilobyteField(rollup, "Anonymous", source);
  return { rssBytes, anonymousBytes, fileBytes: rssBytes - anonymousBytes };
}

// Samples the whole process from the host side; it sees SQLite, allocator and
// runtime memory that the V8 trace cannot.
export class MemorySampler {
  #peaks: SampledPeaks;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly pid: number,
    intervalMs: number,
  ) {
    const started = performance.now();
    const first = statusSample(pid);
    this.#peaks = {
      samples: 1,
      intervalMs,
      samplingMs: performance.now() - started,
      peakRss: first,
      peakAnonymousBytes: first.anonymousBytes,
      peakFileBytes: first.fileBytes,
    };
    this.#timer = setInterval(() => this.#sample(), intervalMs);
  }

  stop(): SampledPeaks {
    clearInterval(this.#timer);
    this.#sample();
    return this.#peaks;
  }

  #sample(): void {
    const started = performance.now();
    const sample = statusSample(this.pid);
    const peaks = this.#peaks;
    this.#peaks = {
      samples: peaks.samples + 1,
      intervalMs: peaks.intervalMs,
      samplingMs: peaks.samplingMs + performance.now() - started,
      peakRss: sample.rssBytes > peaks.peakRss.rssBytes ? sample : peaks.peakRss,
      peakAnonymousBytes: Math.max(peaks.peakAnonymousBytes, sample.anonymousBytes),
      peakFileBytes: Math.max(peaks.peakFileBytes, sample.fileBytes),
    };
  }
}

// The effective limit is the lowest memory.max on the path to the root.
export function workerdCgroup(pid: number): WorkerdCgroup {
  const unified = readFileSync(`/proc/${pid}/cgroup`, "utf8")
    .split("\n")
    .filter((row) => row.startsWith("0::"));
  const row = unified[0];
  if (unified.length !== 1 || row === undefined) {
    throw new Error("unified cgroup path is unavailable");
  }
  const path = row.slice(3);
  let limit: { memoryMaxBytes: number; memoryMaxSource: string } | null = null;
  for (let current = path; current !== "/" && current !== ""; current = posix.dirname(current)) {
    const value = readFileSync(join("/sys/fs/cgroup", current, "memory.max"), "utf8").trim();
    if (value === "max") continue;
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new Error(`memory.max is invalid in ${current}`);
    if (limit === null || bytes < limit.memoryMaxBytes) {
      limit = { memoryMaxBytes: bytes, memoryMaxSource: current };
    }
  }
  return {
    path,
    memoryMaxBytes: limit?.memoryMaxBytes ?? null,
    memoryMaxSource: limit?.memoryMaxSource ?? null,
  };
}
