// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { ObjectType, RawObject } from "../../../common/objects.js";
import { isPackGraphLimit, type PackGraphExit } from "../shared.js";
import {
  advanceFrontier,
  insertScratchPage,
  packGraphPageSql,
  readFrontierOrigins,
  readFrontierRoots,
  readPreviousScratchPage,
  seedFrontier,
} from "./read-graph-scratch.js";
import { type PackReadScope, withPackReadScope } from "./read-scope.js";

export type PackObjectGraphReader = (
  oids: readonly string[],
  pendingPackId: number | null,
  expectedType: ObjectType | null,
  allowMissing: boolean,
  seeds: ReadonlyMap<string, RawObject>,
  bypassCache: boolean,
  graphEntryLimit: number,
) => Map<string, RawObject>;

interface FrontierMove {
  readonly originId: number;
  readonly exit: string;
  readonly depth: number;
}

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
      const roots = readFrontierRoots(this.db, this.repoId, scope, step);
      let originCount = 0;
      for (const root of roots) originCount += root.origins;
      if (!Number.isSafeInteger(originCount) || originCount < 1 || originCount > wanted.length) {
        throw new CorruptError("paged pack frontier state is invalid");
      }
      const entryLimit = Math.max(this.graphPageEntries, roots.length);
      insertScratchPage(this.db, this.repoId, scope.readId, step, entryLimit);
      const links = this.#readPageLinks(scope, step, seedJson, visiblePendingPackId, entryLimit);
      const exitOf = pageExits(links);

      const moves: FrontierMove[] = [];
      for (const root of roots) {
        const exit = exitOf(root.oid);
        if (exit === null) continue;
        for (const origin of readFrontierOrigins(this.db, this.repoId, scope, step, root.oid)) {
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
      for (const move of moves) {
        const advanced = advanceFrontier(
          this.db,
          this.repoId,
          scope.readId,
          step + 1,
          move.exit,
          move.originId,
          move.depth,
        );
        if (!advanced) throw new CorruptError(`cyclic delta chain at ${move.exit}`);
      }
    }
  }

  #readPageLinks(
    scope: PackReadScope,
    step: number,
    seedJson: string,
    visiblePendingPackId: number,
    entryLimit: number,
  ): Map<string, string | null> {
    const links = new Map<string, string | null>();
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
        visiblePendingPackId,
        this.repoId,
      ),
    )) {
      rowCount++;
      const oid = row.oid;
      const baseOid = row.base_oid;
      if (
        rowCount > entryLimit ||
        typeof oid !== "string" ||
        !isOid(oid) ||
        (baseOid !== null && (typeof baseOid !== "string" || !isOid(baseOid))) ||
        links.has(oid)
      ) {
        throw new CorruptError("paged pack graph contains invalid metadata");
      }
      links.set(oid, baseOid);
    }
    return links;
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
      const roots = readFrontierRoots(this.db, this.repoId, scope, page.step).map(
        (root) => root.oid,
      );
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
function pageExits(
  links: ReadonlyMap<string, string | null>,
): (start: string) => PackGraphExit | null {
  const memo = new Map<string, PackGraphExit>();
  const visiting = new Set<string>();
  return (start: string): PackGraphExit | null => {
    if (!links.has(start)) return null;
    const path: string[] = [];
    let current = start;
    for (;;) {
      const known = memo.get(current);
      if (known !== undefined) break;
      if (visiting.has(current)) throw new CorruptError(`cyclic delta chain at ${current}`);
      visiting.add(current);
      path.push(current);
      const base = links.get(current);
      if (base === null || base === undefined || !links.has(base)) break;
      current = base;
    }
    for (let index = path.length - 1; index >= 0; index--) {
      const oid = path[index]!;
      const base = links.get(oid);
      let exit: PackGraphExit;
      if (base === null || base === undefined) exit = { oid: null, distance: 0 };
      else if (!links.has(base)) exit = { oid: base, distance: 1 };
      else {
        const next = memo.get(base);
        if (next === undefined) {
          throw new CorruptError("paged pack graph did not resolve a local dependency");
        }
        exit = { oid: next.oid, distance: next.distance + 1 };
      }
      memo.set(oid, exit);
      visiting.delete(oid);
    }
    return memo.get(start) ?? null;
  };
}
