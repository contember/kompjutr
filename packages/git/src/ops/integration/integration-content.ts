import { CorruptError } from "../../common/errors.js";
import { hashObject, MODE_EXECUTABLE, MODE_FILE } from "../../common/objects.js";
import { mergeText, type TextMergeOptions } from "../../diff/xmerge.js";
import type {
  ConflictStructuralEntry,
  ContentStructuralEntry,
  StructuralIntegrationEntry,
} from "./integration-structure.js";
import type { ContentCandidate, IntegrationEntry } from "./integration-types.js";

const EMPTY_BLOB = new Uint8Array();

export function candidateOids(entry: ContentCandidate): readonly string[] {
  return entry.base === null
    ? [entry.current.oid, entry.incoming.oid]
    : [entry.base.oid, entry.current.oid, entry.incoming.oid];
}

export function validateBlobBatch(
  requested: readonly string[],
  blobs: ReadonlyMap<string, Uint8Array>,
  remaining: readonly string[],
  reportedBytes: number,
): void {
  const returned = [...blobs.keys()];
  if (returned.length === 0 || returned.length + remaining.length !== requested.length) {
    throw new CorruptError("blob batch returned an invalid prefix length");
  }
  let bytes = 0;
  for (let index = 0; index < returned.length; index++) {
    const oid = returned[index]!;
    if (oid !== requested[index]) throw new CorruptError("blob batch returned reordered objects");
    const data = blobs.get(oid);
    if (data === undefined || hashObject("blob", data) !== oid) {
      throw new CorruptError(`blob ${oid} did not match its object id`);
    }
    bytes += data.length;
  }
  for (let index = 0; index < remaining.length; index++) {
    if (remaining[index] !== requested[index + returned.length]) {
      throw new CorruptError("blob batch returned invalid remaining objects");
    }
  }
  if (bytes !== reportedBytes) throw new CorruptError("blob batch returned an invalid byte count");
}

export function passThroughEntry(entry: StructuralIntegrationEntry): IntegrationEntry {
  if (entry.kind === "content") {
    throw new CorruptError("unresolved integration content escaped the content phase");
  }
  if (entry.kind === "clean") {
    return { ...entry, content: null };
  }
  return { ...entry, content: null };
}

export function isRegularMode(mode: string): boolean {
  return mode === MODE_FILE || mode === MODE_EXECUTABLE;
}

export function ordinaryContentCandidate(entry: ContentStructuralEntry): ContentCandidate {
  return {
    path: entry.path,
    base: entry.base,
    current: entry.current,
    incoming: entry.incoming,
    resultMode: entry.resultMode,
    stages: { base: entry.base, current: entry.current, incoming: entry.incoming },
    forceAddAddConflict: false,
  };
}

export function virtualAddAddCandidate(entry: ConflictStructuralEntry): ContentCandidate | null {
  const current = entry.stages.current;
  const incoming = entry.stages.incoming;
  if (
    entry.conflict !== "add/add" ||
    current === null ||
    incoming === null ||
    !isRegularMode(current.mode) ||
    !isRegularMode(incoming.mode)
  ) {
    return null;
  }
  return {
    path: entry.path,
    base: null,
    current,
    incoming,
    resultMode: current.mode,
    stages: entry.stages,
    forceAddAddConflict: current.mode !== incoming.mode,
  };
}
export function resolveContentCandidate(
  entry: ContentCandidate,
  loaded: ReadonlyMap<string, Uint8Array>,
  text: TextMergeOptions,
  virtualAncestor: boolean,
): IntegrationEntry {
  const base = entry.base === null ? EMPTY_BLOB : loaded.get(entry.base.oid);
  const current = loaded.get(entry.current.oid);
  const incoming = loaded.get(entry.incoming.oid);
  if (base === undefined || current === undefined || incoming === undefined) {
    throw new CorruptError("integration blob batch omitted a required candidate object");
  }
  const merged = mergeText(base, current, incoming, text);
  const stages = entry.stages;
  if (merged.kind === "binary") {
    if (!virtualAncestor) {
      return {
        kind: "conflict",
        path: entry.path,
        conflict: "binary",
        stages,
        resultMode: entry.resultMode,
        content: current,
      };
    }
    return {
      kind: "clean",
      path: entry.path,
      before: entry.current,
      result: { mode: entry.resultMode, oid: entry.current.oid },
      content: current,
    };
  }
  if (merged.kind === "conflict") {
    if (virtualAncestor) {
      return {
        kind: "clean",
        path: entry.path,
        before: entry.current,
        result: { mode: entry.resultMode, oid: hashObject("blob", merged.content) },
        content: merged.content,
      };
    }
    return {
      kind: "conflict",
      path: entry.path,
      conflict: "content",
      stages,
      resultMode: entry.resultMode,
      content: merged.content,
      conflicts: merged.conflicts,
    };
  }
  if (!virtualAncestor && entry.forceAddAddConflict) {
    return {
      kind: "conflict",
      path: entry.path,
      conflict: "add/add",
      stages,
      resultMode: entry.resultMode,
      content: merged.content,
    };
  }
  return {
    kind: "clean",
    path: entry.path,
    before: entry.current,
    result: { mode: entry.resultMode, oid: hashObject("blob", merged.content) },
    content: merged.content,
  };
}
