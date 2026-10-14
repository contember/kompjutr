import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { resetPeakRss, statusBytes } from "../bench/workerd/proc-memory.js";

it("resets an actual Linux process high-water mark after its allocation is released", async () => {
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      "--input-type=module",
      "-e",
      `
        function allocate() {
          const bytes = Buffer.alloc(64 * 1024 * 1024, 1);
          if (bytes[bytes.length - 1] !== 1) throw new Error("allocation was not touched");
        }
        allocate();
        for (let pass = 0; pass < 3; pass++) {
          globalThis.gc();
          await new Promise(resolve => setImmediate(resolve));
        }
        process.stdin.resume();
        process.stdout.write("ready");
      `,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw new Error("memory fixture exited before readiness");
      }),
    ]);
    if (child.pid === undefined) throw new Error("memory fixture has no process ID");
    const priorPeak = statusBytes(child.pid, "VmHWM");
    const current = statusBytes(child.pid, "VmRSS");
    expect(priorPeak - current).toBeGreaterThan(32 * 1024 * 1024);
    const reset = resetPeakRss(child.pid);
    expect(reset.peakRssBytes).toBeLessThan(priorPeak);
    expect(reset.rssBytes).toBeGreaterThan(0);
    expect(statusBytes(child.pid, "VmHWM")).toBeLessThan(priorPeak);
  } finally {
    child.kill();
    await exited;
  }
});

it("fails when the kernel peak-reset write cannot be performed", () => {
  expect(() => resetPeakRss(-1)).toThrow();
});
