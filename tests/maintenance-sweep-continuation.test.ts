import { describe, expect, it } from "vitest";
import { utf8 } from "../packages/git/src/common/bytes.js";
import { hashObject } from "../packages/git/src/common/objects.js";
import {
  type MaintenanceRootCursorState,
  validateMaintenanceRootCursor,
} from "../packages/git/src/store/maintenance/roots/root-contracts.js";
import { DEFAULT_PAGE_ROWS } from "../packages/git/src/store/maintenance/sweep/sweep-contracts.js";
import {
  advanceMaintenanceSweep,
  GC_GRACE_MS,
} from "../packages/git/src/store/maintenance/sweep.js";
import { packMaintenance } from "./helpers/pack-maintenance.js";

function observe(fixture: ReturnType<typeof packMaintenance>) {
  const counts = { examined: 0, pages: 0 };
  const exec = fixture.storage.sql.exec;
  fixture.storage.sql.exec = <Row extends object>(query: string, ...bindings: unknown[]) => {
    const cursor = exec<Row>(query, ...bindings);
    if (query.includes("/* pack-sweep-page */")) {
      counts.pages++;
      expect(query).toContain("pack.pack_id > ?");
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
    await fixture.until("packs");
    const store = fixture.store();
    const run = store.db.run.bind(store.db);
    store.db.run = (query: string, ...bindings: unknown[]): void => {
      if (query.includes("SET cursor_ordinal = ? WHERE"))
        throw new Error("cursor publication failed");
      run(query, ...bindings);
    };
    try {
      expect(() => advanceMaintenanceSweep(store.shared, { nowMs: fixture.clock.value })).toThrow(
        "cursor publication failed",
      );
    } finally {
      store.db.run = run;
    }
    expect(cursor(fixture)).toMatchObject({ cursor_ordinal: null, cursor_text: null });
    expect(fixture.db.scalar("SELECT reclaimed_packs FROM git_maintenance_runs")).toBe(0);
    expect(fixture.store().read(hashObject("blob", bytes))?.data).toEqual(bytes);
    expect(
      fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", packed.packId),
    ).toBe(1);
    expect(await fixture.call()).toMatchObject({ reclaimedPacks: 1 });
    expect(cursor(fixture)).toMatchObject({ cursor_ordinal: packed.packId, cursor_text: null });
  });

  it("bounds cold public pages, finishes in one pass across deletions, and clears the finish cursor", async () => {
    const fixture = packMaintenance();
    await fixture.runtime().git.init({ dir: "/repo" });
    const firstDead = await fixture.full(utf8.encode("first pass deletion\n"));
    const liveCount = 2 * DEFAULT_PAGE_ROWS + 1;
    const lives = [];
    for (let index = 0; index < liveCount; index++) {
      const data = utf8.encode(`revived member ${index}\n`);
      lives.push(data);
      await fixture.full(data);
    }
    const lastDead = await fixture.full(utf8.encode("last dead pack\n"));
    // Nominate every pack, then revive the middle ones: each still carries a
    // candidate row, so the sweep pages over them without deleting.
    await fixture.until("finish", 3 * liveCount + 30);
    for (let index = 0; index < liveCount; index++) {
      await fixture.runtime().git.updateRef({
        dir: "/repo",
        ref: `refs/tags/live-${index}`,
        value: hashObject("blob", lives[index]!),
      });
    }
    fixture.clock.value += GC_GRACE_MS;
    const young = utf8.encode("young loose object between sweep passes\n");
    fixture.store().write("blob", young);
    await fixture.until("packs", 3 * liveCount + 30);
    expect(cursor(fixture).next_eligible_ms).toBe(fixture.clock.value + GC_GRACE_MS);
    const counts = observe(fixture);
    let fullPages = 0;
    let finished = false;
    let previousReclaimed = 0;
    const bound = 3 * (Math.ceil((liveCount + 2) / DEFAULT_PAGE_ROWS) + 4 + 1);
    for (let call = 0; call < bound; call++) {
      counts.examined = 0;
      counts.pages = 0;
      const before = cursor(fixture);
      const result = await fixture.call();
      const after = cursor(fixture);
      expect(counts.pages).toBe(1);
      expect(counts.examined).toBeLessThanOrEqual(DEFAULT_PAGE_ROWS);
      expect(result.reclaimedPacks - previousReclaimed).toBeLessThanOrEqual(1);
      previousReclaimed = result.reclaimedPacks;
      expect(after.cursor_checkout_id).toBeNull();
      expect(after.root_source).toBe("done");
      if (result.phase === "packs") expect(after.next_eligible_ms).toBe(before.next_eligible_ms);
      expect(after.cursor_text).toBeNull();
      if (result.phase === "packs") {
        // The cursor only advances within the one pass: nothing restarts from the first pack.
        expect(after.cursor_ordinal).not.toBeNull();
        if (before.cursor_ordinal !== null) {
          expect(after.cursor_ordinal).toBeGreaterThan(before.cursor_ordinal);
        }
        if (counts.examined === DEFAULT_PAGE_ROWS) fullPages++;
      }
      if (result.phase === "finish") {
        expect(after.cursor_ordinal).toBeNull();
        expect(after.cursor_text).toBeNull();
        finished = true;
        break;
      }
    }
    expect(finished).toBe(true);
    expect(fullPages).toBeGreaterThanOrEqual(2);
    expect(previousReclaimed).toBe(2);
    for (const packId of [firstDead.packId, lastDead.packId]) {
      expect(
        fixture.db.scalar("SELECT count(*) FROM git_pack_meta WHERE pack_id = ?", packId),
      ).toBe(0);
    }
    for (const live of lives)
      expect(fixture.store().read(hashObject("blob", live))?.data).toEqual(live);
  });

  it("clears a mid-pass cold sweep cursor when the root epoch changes", async () => {
    const fixture = packMaintenance();
    await fixture.runtime().git.init({ dir: "/repo" });
    await fixture.full(utf8.encode("epoch dead pack\n"));
    const retained = utf8.encode("epoch retained pack\n");
    await fixture.full(retained);
    await fixture.until("finish");
    fixture.clock.value += GC_GRACE_MS;
    await fixture.until("packs");
    await fixture.call();
    expect(cursor(fixture)).toMatchObject({ cursor_text: null });
    expect(cursor(fixture).cursor_ordinal).not.toBeNull();
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
      phase: "packs",
      rootSource: "done",
      cursorCheckoutId: null,
      cursorText: null,
      cursorOrdinal: 0,
    };
    expect(() => validateMaintenanceRootCursor(sweep)).not.toThrow();
    expect(() => validateMaintenanceRootCursor({ ...sweep, cursorOrdinal: null })).not.toThrow();
    for (const changed of [
      { ...sweep, phase: "finish" },
      { ...sweep, phase: "mark" },
      { ...sweep, cursorOrdinal: -1 },
      { ...sweep, cursorText: "unknown" },
      { ...sweep, cursorText: "retry" },
      { ...sweep, cursorCheckoutId: 1 },
    ])
      expect(() => validateMaintenanceRootCursor(changed)).toThrow();
    const loose: MaintenanceRootCursorState = { ...sweep, phase: "loose", cursorOrdinal: null };
    expect(() => validateMaintenanceRootCursor(loose)).not.toThrow();
    expect(() =>
      validateMaintenanceRootCursor({ ...loose, cursorText: hashObject("blob", utf8.encode("")) }),
    ).not.toThrow();
    for (const changed of [
      { ...loose, cursorText: "not an oid" },
      { ...loose, cursorOrdinal: 0 },
      { ...loose, cursorCheckoutId: 1 },
    ])
      expect(() => validateMaintenanceRootCursor(changed)).toThrow();
  });
});
