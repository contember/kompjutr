import { describe, expect, it } from "vitest";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import {
  type MaintenanceRootCursorState,
  PACK_SWEEP_RETRY,
  validateMaintenanceRootCursor,
} from "../packages/git/src/store/maintenance/roots/root-contracts.js";
import { DEFAULT_PAGE_ROWS } from "../packages/git/src/store/maintenance/sweep/sweep-contracts.js";
import {
  advanceMaintenanceSweep,
  GC_GRACE_MS,
} from "../packages/git/src/store/maintenance/sweep.js";
import { lifecycleDelta, lifecyclePack, packMaintenance } from "./helpers/pack-maintenance.js";

function observe(fixture: ReturnType<typeof packMaintenance>) {
  const counts = { examined: 0, pages: 0, checks: 0 };
  const exec = fixture.storage.sql.exec;
  fixture.storage.sql.exec = <Row extends object>(query: string, ...bindings: unknown[]) => {
    const cursor = exec<Row>(query, ...bindings);
    if (query.startsWith("WITH RECURSIVE target(repo_id, pack_id)")) counts.checks++;
    if (query.includes("/* pack-sweep-page */")) {
      counts.pages++;
      expect(query).toContain("candidate.pack_id > ?");
      expect(query).toContain("LIMIT ?");
      expect(bindings.at(-1)).toBe(DEFAULT_PAGE_ROWS);
      const next = cursor.next.bind(cursor);
      cursor.next = () => {
        const row = next();
        if (!row.done) counts.examined++;
        return row;
      };
    }
    return cursor;
  };
  return counts;
}

function cursor(fixture: ReturnType<typeof packMaintenance>) {
  const row = fixture.db.one<{
    cursor_ordinal: number | null;
    cursor_text: string | null;
    cursor_checkout_id: number | null;
    root_source: string;
    next_eligible_ms: number | null;
  }>(
    "SELECT cursor_ordinal, cursor_text, cursor_checkout_id, root_source, next_eligible_ms FROM git_maintenance_runs",
  );
  if (row === undefined) throw new Error("sweep continuation disappeared");
  return row;
}

describe("pack sweep continuation", () => {
  it("rolls back deletion and counters when cursor publication fails", async () => {
    const fixture = packMaintenance();
    await fixture.runtime().git.init({ dir: "/repo" });
    const bytes = utf8.encode("cursor rollback object\n");
    const packed = await fixture.full(bytes);
    await fixture.until("finish");
    fixture.clock.value += GC_GRACE_MS;
    await fixture.until("sweep-packs");
    const store = fixture.store();
    const one = store.db.one.bind(store.db);
    store.db.one = <Row extends object>(query: string, ...bindings: unknown[]): Row | undefined => {
      if (query.includes("SET cursor_ordinal = ?, cursor_text = ?"))
        throw new Error("cursor publication failed");
      return one<Row>(query, ...bindings);
    };
    try {
      expect(() => advanceMaintenanceSweep(store.shared, { nowMs: fixture.clock.value })).toThrow(
        "cursor publication failed",
      );
    } finally {
      store.db.one = one;
    }
    expect(cursor(fixture)).toMatchObject({ cursor_ordinal: null, cursor_text: null });
    expect(fixture.db.scalar("SELECT reclaimed_packs FROM git_maintenance_runs")).toBe(0);
    expect(fixture.store().read(hashObject("blob", bytes))?.data).toEqual(bytes);
    expect(
      fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", packed.packId),
    ).toBe(1);
    expect(await fixture.call()).toMatchObject({ reclaimedPacks: 1 });
    expect(cursor(fixture)).toMatchObject({
      cursor_ordinal: packed.packId,
      cursor_text: PACK_SWEEP_RETRY,
    });
  });

  it("bounds cold public pages, preserves dirty progress, retries earlier bases, and clears the finish cursor", async () => {
    const fixture = packMaintenance();
    await fixture.runtime().git.init({ dir: "/repo" });
    const early = utf8.encode("earlier dead base\n");
    const earlyPack = await fixture.full(early);
    const firstDead = await fixture.full(utf8.encode("first pass deletion\n"));
    const blockedCount = 2 * DEFAULT_PAGE_ROWS + 1;
    const bases = [];
    for (let index = 0; index < blockedCount; index++) {
      const data = utf8.encode(`blocked base ${index}\n`);
      bases.push({ data, packId: (await fixture.full(data)).packId });
    }
    for (let index = 0; index < bases.length; index++) {
      const base = bases[index]!;
      const live = utf8.encode(`live member ${index}\n`);
      await fixture.ingest(
        lifecyclePack((writer) => {
          writer.refDelta(
            hashObject("blob", base.data),
            lifecycleDelta(base.data.length, utf8.encode(`dead child ${index}\n`)),
          );
          writer.object("blob", live);
        }, 2),
      );
      await fixture.runtime().git.updateRef({
        dir: "/repo",
        ref: `refs/tags/live-${index}`,
        value: hashObject("blob", live),
      });
    }
    const child = await fixture.ingest(
      lifecyclePack(
        (writer) =>
          writer.refDelta(
            hashObject("blob", early),
            lifecycleDelta(early.length, utf8.encode("later dead child\n")),
          ),
        1,
      ),
    );
    const lastDead = await fixture.full(utf8.encode("last dead pack\n"));
    await fixture.until("finish", 3 * blockedCount + 30);
    fixture.clock.value += GC_GRACE_MS;
    const young = utf8.encode("young loose object between sweep passes\n");
    fixture.store().write("blob", young);
    await fixture.until("sweep-packs", 3 * blockedCount + 30);
    expect(cursor(fixture).next_eligible_ms).toBe(fixture.clock.value + GC_GRACE_MS);
    const counts = observe(fixture);
    let stickyPages = 0;
    let restarts = 0;
    let finished = false;
    let deletedEarlierOnRetry = false;
    let previousReclaimed = 0;
    const bound = 3 * (Math.ceil((blockedCount + 4) / DEFAULT_PAGE_ROWS) + 4 + 1);
    for (let call = 0; call < bound; call++) {
      counts.examined = 0;
      counts.pages = 0;
      counts.checks = 0;
      const before = cursor(fixture);
      const result = await fixture.call();
      const after = cursor(fixture);
      expect(counts.pages).toBe(1);
      expect(counts.examined).toBeLessThanOrEqual(DEFAULT_PAGE_ROWS);
      expect(counts.checks).toBe(counts.examined);
      expect(result.reclaimedPacks - previousReclaimed).toBeLessThanOrEqual(1);
      previousReclaimed = result.reclaimedPacks;
      expect(after.cursor_checkout_id).toBeNull();
      expect(after.root_source).toBe("done");
      if (result.phase === "sweep-packs")
        expect(after.next_eligible_ms).toBe(before.next_eligible_ms);
      if (
        before.cursor_text === PACK_SWEEP_RETRY &&
        counts.examined === DEFAULT_PAGE_ROWS &&
        result.reclaimedPacks === 1
      ) {
        stickyPages++;
        expect(after.cursor_text).toBe(PACK_SWEEP_RETRY);
      }
      if (
        before.cursor_text === PACK_SWEEP_RETRY &&
        after.cursor_ordinal === null &&
        result.phase === "sweep-packs"
      ) {
        restarts++;
        expect(after.cursor_text).toBeNull();
      }
      if (restarts > 0 && after.cursor_ordinal === earlyPack.packId) deletedEarlierOnRetry = true;
      if (result.phase === "finish") {
        expect(after.cursor_ordinal).toBeNull();
        expect(after.cursor_text).toBeNull();
        finished = true;
        break;
      }
    }
    expect(finished).toBe(true);
    expect(stickyPages).toBeGreaterThanOrEqual(2);
    expect(restarts).toBe(2);
    expect(deletedEarlierOnRetry).toBe(true);
    for (const packId of [earlyPack.packId, firstDead.packId, child.packId, lastDead.packId]) {
      expect(
        fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", packId),
      ).toBe(0);
    }
    for (const base of bases)
      expect(fixture.store().read(hashObject("blob", base.data))?.data).toEqual(base.data);
  });

  it("clears a dirty cold sweep cursor when the root epoch changes", async () => {
    const fixture = packMaintenance();
    await fixture.runtime().git.init({ dir: "/repo" });
    await fixture.full(utf8.encode("epoch dead pack\n"));
    const retained = utf8.encode("epoch retained pack\n");
    await fixture.full(retained);
    await fixture.until("finish");
    fixture.clock.value += GC_GRACE_MS;
    await fixture.until("sweep-packs");
    await fixture.call();
    expect(cursor(fixture).cursor_text).toBe(PACK_SWEEP_RETRY);
    await fixture.runtime().git.updateRef({
      dir: "/repo",
      ref: "refs/tags/new-root",
      value: hashObject("blob", retained),
    });
    expect(await fixture.call()).toMatchObject({ phase: "roots", restarted: true });
    expect(cursor(fixture)).toMatchObject({
      cursor_ordinal: null,
      cursor_text: null,
      cursor_checkout_id: null,
    });
    await fixture.until("finish");
    expect(fixture.store().read(hashObject("blob", retained))?.data).toEqual(retained);
  });

  it("accepts sweep ID zero and rejects cross-phase or malformed continuations", () => {
    const sweep: MaintenanceRootCursorState = {
      phase: "sweep-packs",
      rootSource: "done",
      cursorCheckoutId: null,
      cursorText: null,
      cursorOrdinal: 0,
    };
    expect(() => validateMaintenanceRootCursor(sweep)).not.toThrow();
    expect(() =>
      validateMaintenanceRootCursor({ ...sweep, cursorText: PACK_SWEEP_RETRY }),
    ).not.toThrow();
    for (const changed of [
      { ...sweep, phase: "finish" },
      { ...sweep, phase: "mark" },
      { ...sweep, cursorOrdinal: -1 },
      { ...sweep, cursorText: "unknown" },
      { ...sweep, cursorText: PACK_SWEEP_RETRY, cursorOrdinal: null },
      { ...sweep, cursorCheckoutId: 1 },
    ])
      expect(() => validateMaintenanceRootCursor(changed)).toThrow();
  });
});
