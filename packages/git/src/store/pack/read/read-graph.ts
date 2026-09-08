// Derived from dgit (MIT, Copyright (c) 2026 Divy Srivastava),
// https://github.com/littledivy/dgit — the three-phase ingest, the rotating offset window, the deferred-delta table and the iterative delta-chain walk all follow dgit's src/git/packstore.ts.

import type { SqlDatabase } from "@kompjutr/sqlite";
import { isOid } from "../../../common/bytes.js";
import { CorruptError } from "../../../common/errors.js";
import type { ObjectType, RawObject } from "../../../common/objects.js";
import {
  isPackGraphLimit,
  type PackGraphExit,
  type PackGraphOrigin,
  type PackGraphPage,
} from "../shared.js";

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
    {
      const wanted = [...new Set(oids)];
      let frontier = new Map<string, PackGraphOrigin[]>();
      for (const oid of wanted) {
        frontier.set(oid, [{ rootOid: oid, depth: 0, checkpoints: new Set([oid]) }]);
      }
      const pages: PackGraphPage[] = [];
      const seedJson = JSON.stringify([...seeds.keys()]);
      const visiblePendingPackId = pendingPackId ?? -1;

      while (frontier.size > 0) {
        let originCount = 0;
        for (const origins of frontier.values()) originCount += origins.length;
        if (!Number.isSafeInteger(originCount) || originCount < 1 || originCount > wanted.length) {
          throw new CorruptError("paged pack frontier state is invalid");
        }
        const entryLimit = Math.max(this.graphPageEntries, frontier.size);
        const pageRoots = [...frontier.keys()];
        pages.push({ roots: pageRoots, entryLimit });
        const rootJson = JSON.stringify(pageRoots);
        const links = new Map<string, string | null>();
        let rowCount = 0;
        for (const row of this.db.iterate(
          `WITH RECURSIVE /* pack-graph-page */
               frontier(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
               seeds(oid) AS MATERIALIZED (SELECT value FROM json_each(?)),
               reachable(oid) AS (
                 SELECT object.oid
                   FROM frontier
                   JOIN git_pack_objects object
                     ON object.repo_id = ? AND object.oid = frontier.oid
                   JOIN git_pack_meta pack
                     ON pack.repo_id = object.repo_id AND pack.pack_id = object.pack_id
                    AND (pack.state = 'complete' OR object.pack_id = ?)
                 UNION
                 SELECT base.oid
                   FROM reachable
                   JOIN git_pack_objects child
                     ON child.repo_id = ? AND child.oid = reachable.oid
                   JOIN git_pack_meta child_pack
                     ON child_pack.repo_id = child.repo_id
                    AND child_pack.pack_id = child.pack_id
                    AND (child_pack.state = 'complete' OR child.pack_id = ?)
                   JOIN git_pack_objects base
                     ON base.repo_id = child.repo_id AND base.oid = child.base_oid
                   JOIN git_pack_meta base_pack
                     ON base_pack.repo_id = base.repo_id AND base_pack.pack_id = base.pack_id
                    AND (base_pack.state = 'complete' OR base.pack_id = ?)
                  WHERE NOT EXISTS (SELECT 1 FROM seeds WHERE seeds.oid = base.oid)
                  LIMIT ${entryLimit}
               )
             SELECT object.oid, object.base_oid
               FROM reachable
               JOIN git_pack_objects object
                 ON object.repo_id = ? AND object.oid = reachable.oid`,
          rootJson,
          seedJson,
          this.repoId,
          visiblePendingPackId,
          this.repoId,
          visiblePendingPackId,
          visiblePendingPackId,
          this.repoId,
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

        const memo = new Map<string, PackGraphExit>();
        const visiting = new Set<string>();
        const pageExit = (start: string): PackGraphExit | null => {
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

        const moves: { origin: PackGraphOrigin; exit: string; depth: number }[] = [];
        for (const [root, origins] of frontier) {
          const exit = pageExit(root);
          if (exit === null) continue;
          for (const origin of origins) {
            const depth = origin.depth + exit.distance;
            if (!Number.isSafeInteger(depth) || depth > this.maxDeltaDepth) {
              throw new CorruptError(
                `delta chain deeper than ${this.maxDeltaDepth} at ${origin.rootOid}`,
              );
            }
            if (exit.oid !== null && !seeds.has(exit.oid)) {
              moves.push({ origin, exit: exit.oid, depth });
            }
          }
        }
        if (moves.length === 0) break;

        const nextFrontier = new Map<string, PackGraphOrigin[]>();
        for (const move of moves) {
          if (move.origin.checkpoints.has(move.exit)) {
            throw new CorruptError(`cyclic delta chain at ${move.exit}`);
          }
          move.origin.depth = move.depth;
          move.origin.checkpoints.add(move.exit);
          const origins = nextFrontier.get(move.exit);
          if (origins === undefined) nextFrontier.set(move.exit, [move.origin]);
          else origins.push(move.origin);
        }
        if (nextFrontier.size === 0) {
          throw new CorruptError("paged pack graph traversal made no progress");
        }
        frontier = nextFrontier;
      }

      let checkpoint: Map<string, RawObject> | null = null;
      for (let index = pages.length - 1; index >= 0; index--) {
        const page = pages[index]!;
        let pageResult: Map<string, RawObject>;
        let pageSeeds = seeds;
        if (checkpoint !== null) {
          const combined = new Map(seeds);
          for (const [oid, object] of checkpoint) combined.set(oid, object);
          pageSeeds = combined;
        }
        try {
          pageResult = this.readObjects(
            page.roots,
            pendingPackId,
            index === 0 ? expectedType : null,
            index === 0 ? allowMissing : true,
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
        checkpoint = pageResult;
      }
      if (checkpoint === null) {
        throw new CorruptError("paged pack graph produced no resolution page");
      }
      return checkpoint;
    }
  }
}
