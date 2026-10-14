import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { phaseCounts } from "../../bench/server/control.js";
import { ServerBench } from "../../bench/server/worker.js";
import { SqliteTestStorage } from "../helpers/storage.js";

it("preserves phase counters when a benchmark Durable Object is reconstructed", async () => {
  const storage = new SqliteTestStorage();
  const identity = randomUUID();
  const context = {
    id: { toString: () => identity },
    storage: {
      sql: storage.sql,
      transactionSync: <T>(closure: () => T) => storage.transactionSync(closure),
      setAlarm: async () => {},
      getAlarm: async () => null,
    },
  };
  const environment = { BENCH_MARKER_URL: "http://unused.invalid" };
  const phase = randomUUID();
  const request = (path: string) => new Request(`http://benchmark/__bench/${path}`);
  try {
    const first = new ServerBench(context, environment);
    await first.fetch(request(`reset?phase=${phase}`));
    first.counts.sql.exec("SELECT 42").toArray();
    const before = phaseCounts(await (await first.fetch(request("counts"))).json(), phase);
    const second = new ServerBench(context, environment);
    const after = phaseCounts(await (await second.fetch(request("counts"))).json(), phase);
    expect(before.statements).toBe(1);
    expect(before.returnedRows).toBe(1);
    expect(after.generations).toBe(2);
    expect(after.statements).toBeGreaterThan(before.statements);
    expect(after.returnedRows).toBeGreaterThan(before.returnedRows);
    expect(() => phaseCounts(after, randomUUID())).toThrow("phase epoch lost");
    await second.fetch(request(`reset?phase=${phase}`));
    const reset = phaseCounts(await (await second.fetch(request("counts"))).json(), phase);
    expect(reset.statements).toBe(0);
    expect(reset.returnedRows).toBe(0);
    expect(reset.generations).toBe(1);
  } finally {
    storage.db.close();
  }
});
