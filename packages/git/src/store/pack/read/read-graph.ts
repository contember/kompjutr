// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { ObjectType, RawObject } from "../../../common/objects.js";
import { int, nullable, RowShape, text } from "../../../common/rows.js";
import { isPackGraphLimit, type PackGraphExit } from "../shared.js";
import {
  advanceFrontier,
  type FrontierMove,
  insertScratchPage,
  packGraphPageSql,
  readFrontierGroups,
  readFrontierRoots,
  readPreviousScratchPage,
  seedFrontier,
} from "./read-graph-scratch.js";
import { type PackReadScope, withPackReadScope } from "./read-scope.js";

const INVALID_PAGE = "paged pack graph contains invalid metadata";

const PAGE_LINK_ROW = new RowShape(
  {
    oid: text(INVALID_PAGE).where(isOid, INVALID_PAGE),
    pack_id: int(0, Number.MAX_SAFE_INTEGER, INVALID_PAGE),
    offset: int(0, Number.MAX_SAFE_INTEGER, INVALID_PAGE),
    base_offset: nullable(int(0, Number.MAX_SAFE_INTEGER, INVALID_PAGE)),
    base_oid: nullable(text(INVALID_PAGE).where(isOid, INVALID_PAGE)),
    start: int(0, 1, INVALID_PAGE),
  },
  INVALID_PAGE,
);

/** One page entry, keyed physically; `baseKey` is null for a full object. */
interface PageLink {
  readonly oid: string;
  readonly baseKey: string | null;
  readonly baseOid: string | null;
}

interface PageLinks {
  readonly links: ReadonlyMap<string, PageLink>;
  /** The entry where each requested OID's chain starts. */
  readonly starts: ReadonlyMap<string, string>;
}

export type PackObjectGraphReader = (
  oids: readonly string[],
  pendingPackId: number | null,
  expectedType: ObjectType | null,
  allowMissing: boolean,
  seeds: ReadonlyMap<string, RawObject>,
  bypassCache: boolean,
  graphEntryLimit: number,
) => Map<string, RawObject>;

export class PackGraphPager {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
    private readonly maxDeltaDepth: number,
    private readonly graphPageEntries: number,
    private readonly readObjects: PackObjectGraphReader,
  ) {}

  /** Discover one bounded union graph and resolve its checkpoint pages in reverse. */
  readObjectsPaged(
    oids: readonly string[],
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject>,
    bypassCache: boolean,
  ): Map<string, RawObject> {
    const wanted = [...new Set(oids)];
    return withPackReadScope(this.db, this.repoId, pendingPackId, (scope) => {
      seedFrontier(this.db, this.repoId, scope.readId, wanted);
      const lastStep = this.#discover(scope, wanted, pendingPackId, seeds);
      return this.#resolve(
        scope,
        lastStep,
        pendingPackId,
        expectedType,
        allowMissing,
        seeds,
        bypassCache,
      );
    });
  }

  /** Walk the frontier forwards, recording one page row per discovery step. */
  #discover(
    scope: PackReadScope,
    wanted: readonly string[],
    pendingPackId: number | null,
    seeds: ReadonlyMap<string, RawObject>,
  ): number {
    const seedJson = JSON.stringify([...seeds.keys()]);
    const visiblePendingPackId = pendingPackId ?? -1;
    for (let step = 0; ; step++) {
      const groups = readFrontierGroups(this.db, this.repoId, scope, step, wanted.length);
      const entryLimit = Math.max(this.graphPageEntries, groups.length);
      insertScratchPage(this.db, this.repoId, scope.readId, step, entryLimit);
      const page = this.#readPageLinks(scope, step, seedJson, visiblePendingPackId, entryLimit);
      const exitOf = pageExits(page.links);

      const moves: FrontierMove[] = [];
      for (const group of groups) {
        const start = page.starts.get(group.oid);
        const exit = start === undefined ? null : exitOf(start);
        if (exit === null) continue;
        for (const origin of group.origins) {
          const depth = origin.depth + exit.distance;
          if (!Number.isSafeInteger(depth) || depth > this.maxDeltaDepth) {
            const rootOid = wanted[origin.originId];
            if (rootOid === undefined)
              throw new CorruptError("paged pack frontier lost its origin");
            throw new CorruptError(`delta chain deeper than ${this.maxDeltaDepth} at ${rootOid}`);
          }
          if (exit.oid !== null && !seeds.has(exit.oid)) {
            moves.push({ originId: origin.originId, exit: exit.oid, depth });
          }
        }
      }
      if (moves.length === 0) return step;
      const cyclic = advanceFrontier(this.db, this.repoId, scope, step + 1, moves);
      if (cyclic !== null) throw new CorruptError(`cyclic delta chain at ${cyclic}`);
    }
  }

  #readPageLinks(
    scope: PackReadScope,
    step: number,
    seedJson: string,
    visiblePendingPackId: number,
    entryLimit: number,
  ): PageLinks {
    const links = new Map<string, PageLink>();
    const starts = new Map<string, string>();
    let rowCount = 0;
    for (const row of scope.scoped(
      this.db.iterate(
        packGraphPageSql(entryLimit),
        this.repoId,
        scope.readId,
        step,
        seedJson,
        this.repoId,
        visiblePendingPackId,
        this.repoId,
        visiblePendingPackId,
        this.repoId,
        this.repoId,
      ),
    )) {
      rowCount++;
      const entry = PAGE_LINK_ROW.decode(row);
      const key = `${entry.pack_id}:${entry.offset}`;
      if (rowCount > entryLimit || links.has(key)) throw new CorruptError(INVALID_PAGE);
      links.set(key, {
        oid: entry.oid,
        baseKey: entry.base_offset === null ? null : `${entry.pack_id}:${entry.base_offset}`,
        baseOid: entry.base_oid,
      });
      if (entry.start === 1) starts.set(entry.oid, key);
    }
    return { links, starts };
  }

  /** Resolve the recorded pages back to front, each seeded by its successor. */
  #resolve(
    scope: PackReadScope,
    lastStep: number,
    pendingPackId: number | null,
    expectedType: ObjectType | null,
    allowMissing: boolean,
    seeds: ReadonlyMap<string, RawObject>,
    bypassCache: boolean,
  ): Map<string, RawObject> {
    let checkpoint: Map<string, RawObject> | null = null;
    for (let before = lastStep + 1; ; ) {
      const page = readPreviousScratchPage(this.db, this.repoId, scope.readId, before);
      if (page === null) break;
      const roots = readFrontierRoots(this.db, this.repoId, scope, page.step);
      let pageSeeds = seeds;
      if (checkpoint !== null) {
        const combined = new Map(seeds);
        for (const [oid, object] of checkpoint) combined.set(oid, object);
        pageSeeds = combined;
      }
      try {
        checkpoint = this.readObjects(
          roots,
          pendingPackId,
          page.step === 0 ? expectedType : null,
          page.step === 0 ? allowMissing : true,
          pageSeeds,
          bypassCache,
          page.entryLimit,
        );
      } catch (error) {
        if (isPackGraphLimit(error)) {
          throw new CorruptError("paged packed dependency graph exceeded its discovered page");
        }
        throw error;
      }
      before = page.step;
    }
    if (checkpoint === null) {
      throw new CorruptError("paged pack graph produced no resolution page");
    }
    return checkpoint;
  }
}

/** Memoized exit of one page-local chain: where it leaves the page, and how far. */
function pageExits(links: ReadonlyMap<string, PageLink>): (start: string) => PackGraphExit | null {
  const memo = new Map<string, PackGraphExit>();
  const visiting = new Set<string>();
  return (start: string): PackGraphExit | null => {
    if (!links.has(start)) return null;
    const path: string[] = [];
    let current = start;
    for (;;) {
      if (memo.has(current)) break;
      const link = links.get(current)!;
      if (visiting.has(current)) throw new CorruptError(`cyclic delta chain at ${link.oid}`);
      visiting.add(current);
      path.push(current);
      if (link.baseKey === null || !links.has(link.baseKey)) break;
      current = link.baseKey;
    }
    for (let index = path.length - 1; index >= 0; index--) {
      const key = path[index]!;
      const link = links.get(key)!;
      let exit: PackGraphExit;
      if (link.baseKey === null) exit = { oid: null, distance: 0 };
      else if (!links.has(link.baseKey)) exit = { oid: link.baseOid, distance: 1 };
      else {
        const next = memo.get(link.baseKey);
        if (next === undefined) {
          throw new CorruptError("paged pack graph did not resolve a local dependency");
        }
        exit = { oid: next.oid, distance: next.distance + 1 };
      }
      memo.set(key, exit);
      visiting.delete(key);
    }
    return memo.get(start) ?? null;
  };
}
