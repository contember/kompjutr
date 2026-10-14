import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { requireParentLeaseCpus } from "../memory-run.js";
import { resetPeakRss, workerdCgroup } from "../workerd/proc-memory.js";

export function assertLease(): void {
  requireParentLeaseCpus(1);
}

export class CpuCheckpoints {
  private last = 0;
  private started = 0;
  private peak = 0;
  private count = 0;
  readonly tickMs =
    1000 / Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  constructor(readonly pid: number) {}
  private read(): number {
    if (this.pid === process.pid) {
      const cpu = process.cpuUsage();
      return (cpu.user + cpu.system) / 1000;
    }
    const stat = readFileSync(`/proc/${this.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const user = Number(fields[11]);
    const system = Number(fields[12]);
    if (!Number.isFinite(user) || !Number.isFinite(system))
      throw new Error("invalid process CPU stat");
    return (user + system) * this.tickMs;
  }
  start(): void {
    this.started = this.last = this.read();
    this.peak = 0;
    this.count = 0;
  }
  checkpoint(): void {
    const next = this.read();
    this.peak = Math.max(this.peak, next - this.last);
    this.last = next;
    this.count++;
  }
  finish() {
    this.checkpoint();
    return {
      processCpuMs: this.last - this.started,
      maxProcessCpuBetweenCheckpointsMs: this.peak,
      uninterruptedCpuUpperBoundMs:
        this.peak + (this.pid === process.pid ? 0.001 : 2 * this.tickMs),
      resolutionMs: this.pid === process.pid ? 0.001 : this.tickMs,
      checkpoints: this.count,
      interpretation:
        "Conservative process CPU between acknowledged yield checkpoints; includes native SQL/compression and runtime background work. Two /proc counter rounding errors added to bound; instrumentation changes wall time.",
    };
  }
}

export function memoryContext(pid: number) {
  const cgroup = workerdCgroup(pid);
  const reset = resetPeakRss(pid);
  return {
    processBaselineRssBytes: reset.peakRssBytes,
    processResetPeakRssBytes: reset.peakRssBytes,
    processResetCurrentRssBytes: reset.rssBytes,
    cgroup,
  };
}
