import { applyIndexOwned } from "../../store/checkout/checkout.js";
import type { IndexEntry, IndexSink, IndexStore } from "../../store/index.js";
import type { Repository } from "../repository/repository.js";
import type { TouchedSpec } from "./merge-apply-types.js";
import { requireIdentity } from "./merge-apply-validation.js";
import type { ProjectedMergeEntry } from "./merge-projection.js";
import type { MergeTouchedPath } from "./merge-state.js";

function putIdentity(
  sink: IndexSink,
  path: string,
  stage: number,
  mode: string,
  oid: string,
): void {
  sink.put({
    path,
    stage,
    mode: requireIdentity(mode, oid, path),
    oid,
    size: null,
    mtime: null,
    ino: null,
    rev: null,
  });
}

export function applyIndex<Content>(
  index: IndexStore,
  entries: Iterable<ProjectedMergeEntry<Content>>,
  specs: Iterable<TouchedSpec>,
): void {
  applyIndexOwned(index, (sink) => {
    for (const spec of specs) sink.remove(spec.path);
    for (const entry of entries) {
      sink.remove(entry.path);
      if (entry.stageZero !== null) {
        putIdentity(sink, entry.path, 0, entry.stageZero.mode, entry.stageZero.oid);
      }
      if (entry.stages !== null) {
        if (entry.stages.base !== null) {
          putIdentity(sink, entry.path, 1, entry.stages.base.mode, entry.stages.base.oid);
        }
        if (entry.stages.current !== null) {
          putIdentity(sink, entry.path, 2, entry.stages.current.mode, entry.stages.current.oid);
        }
        if (entry.stages.incoming !== null) {
          putIdentity(sink, entry.path, 3, entry.stages.incoming.mode, entry.stages.incoming.oid);
        }
      }
    }
  });
}

export function restoreIndex(repo: Repository, touched: Iterable<MergeTouchedPath>): void {
  applyIndexOwned(repo.checkout, (sink) => {
    for (const entry of touched) {
      sink.remove(entry.path);
      if (entry.index !== null) {
        const restored: IndexEntry = { path: entry.path, ...entry.index };
        sink.put(restored);
      }
    }
  });
}
