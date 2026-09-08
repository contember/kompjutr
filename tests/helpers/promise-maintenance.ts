import { expect } from "vitest";
import { Workspace } from "../../packages/do/src/runtime/workspace.js";
import { createGit, type GitMaintenanceResult } from "../../packages/git/src/client.js";
import { fetchHttpClient } from "../../packages/git/src/protocol/transport.js";
import { SqliteGitDatabase } from "../../packages/git/src/store/index.js";
import { TestDatabase } from "./db.js";
import { SqliteTestStorage } from "./storage.js";

export function promiseMaintenance() {
  const storage = new SqliteTestStorage();
  const db = new TestDatabase(storage);
  const clock = { value: 1_800_000_000_000 };
  const now = () => clock.value;
  const runtime = () => new Workspace({ storage, git: createGit(), now, http: fetchHttpClient });
  const store = () => {
    const database = new SqliteGitDatabase(db, { now });
    const checkout = database.findCheckout("/repo");
    if (checkout === null) throw new Error("promise fixture checkout missing");
    return database.openCheckout(checkout);
  };
  const trace: { time: number; phase: string; runId: number; restarted: boolean }[] = [];
  const call = async () => {
    const result = await runtime().git.maintenance({ dir: "/repo" });
    trace.push({
      time: clock.value,
      phase: result.phase,
      runId: result.runId,
      restarted: result.restarted,
    });
    return result;
  };
  const until = async (phase: GitMaintenanceResult["phase"]) => {
    for (let calls = 0; calls < 100; calls++) {
      const result = await call();
      if (result.phase === phase) return result;
    }
    throw new Error(`promise maintenance did not reach ${phase}: ${JSON.stringify(trace)}`);
  };
  const marked = (oid: string) =>
    db.scalar<number>("SELECT count(*) FROM git_maintenance_objects WHERE oid = ?", oid);
  const expectReadable = async (head: string, oid: string, data: Uint8Array) => {
    expect(store().read(oid)?.data, JSON.stringify(trace)).toEqual(data);
    expect(await runtime().git.catFile({ dir: "/repo", oid: "HEAD" })).toEqual({
      oid: head,
      bytes: store().read(head)?.data,
    });
    expect((await runtime().git.catFile({ dir: "/repo", oid })).bytes).toEqual(data);
  };
  return { storage, db, clock, runtime, store, trace, call, until, marked, expectReadable };
}
