import { isOid } from "../../common/bytes.js";
import { CorruptError, GitError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type {
  SparseIndexAncestorRequest,
  SparseTreeLeaf,
  SparseWorkspaceRequest,
} from "../contracts.js";

export const MAX_PATHS = 1_000;
export const SPARSE_WORKSPACE_STATE_BYTES = 64 * 1024 * 1024;
export const MAX_ROOT_SEGMENTS = 128;
export const MAX_DEPTH = 64;
export const MAX_EDGE_STEPS = 32_768;
export const MAX_INDEX_ANCESTORS = 32_768;
export const MAX_INDEX_ANCESTOR_ROWS = 32_768;
export const MAX_EXACT_INDEX_ANCESTORS = 1_000;
export const MAX_EXACT_INDEX_ANCESTOR_ROWS = MAX_EXACT_INDEX_ANCESTORS * 6;
export const MAX_SELECTED_ROWS = 32_768;
export const MAX_SELECTED_EXACT_ANCESTORS = 32_768;
export const MAX_SNAPSHOT_DIRECTORIES = 1_000;
export const MAX_SOURCE_ENTRIES = 8_192;
export const ROW_RETAINED_BYTES = 1_024;
export const INDEX_ENTRY_RETAINED_BYTES = 320;
export const INDEX_ANCESTOR_RETAINED_BYTES = 192;
export const SELECTED_INDEX_RETAINED_BYTES = 320;
export const SELECTED_WORKTREE_RETAINED_BYTES = 512;
export const SELECTED_EXACT_SET_RETAINED_BYTES = 128;
export const SELECTED_EXACT_SET_ENTRY_BYTES = 96;
export const SELECTED_EXACT_ARRAY_RETAINED_BYTES = 64;
export const SELECTED_EXACT_ARRAY_SLOT_BYTES = 8;
export const SNAPSHOT_ARRAY_RETAINED_BYTES = 64;
export const SNAPSHOT_ARRAY_SLOT_BYTES = 8;
export const SNAPSHOT_MIN_DIRTY_ROW_RETAINED_BYTES =
  ROW_RETAINED_BYTES + SNAPSHOT_ARRAY_SLOT_BYTES + 4 + 1;
export const SNAPSHOT_MAP_RETAINED_BYTES = 128;
export const SNAPSHOT_MAP_ENTRY_BYTES = 96;
export const SNAPSHOT_REQUEST_RETAINED_BYTES = 512;
export const SNAPSHOT_DIRECTORY_RETAINED_BYTES = 256;
export const SNAPSHOT_ENTRY_RETAINED_BYTES = 256;
export const SNAPSHOT_SOURCE_RETAINED_BYTES = 512;
export const SEGMENT_RETAINED_BYTES = 40;
export const CURSOR_RETAINED_BYTES = 256;
export const OID_RETAINED_BYTES = 112;
export const RESOLUTION_RETAINED_BYTES = 192;
export const SOURCE_RETAINED_BYTES = 512;
export const SNAPSHOT_TREE_PART_JSON_CHARS = 96;
export const SNAPSHOT_TREE_RESOLUTION_RETAINED_BYTES =
  SNAPSHOT_MAP_ENTRY_BYTES +
  RESOLUTION_RETAINED_BYTES +
  SNAPSHOT_ENTRY_RETAINED_BYTES +
  OID_RETAINED_BYTES +
  64;
export const encoder = new TextEncoder();

export interface TreeCursor {
  ordinal: number;
  side: "b" | "c";
  treeOid: string;
  segment: string;
  final: boolean;
  validated: boolean;
  ancestry: string[];
}

export interface TreeResolution {
  leaf: SparseTreeLeaf | null;
  treeOid: string | null;
}

export interface ValidatedRequest {
  json: string;
  segments: string[][];
  retainedBytes: number;
}

export interface ValidatedTreeSource {
  sourceKey: number;
  storage: "loose" | "pack";
  sourceId: number;
  objectSize: number;
  entryCount: number;
  baseCost: number;
}

export interface SourceBudget {
  entries: number;
  bytes: number;
  limit: number;
}

export interface SnapshotRetainedBudget {
  limit: number;
  used: number;
  peak: number;
}

export function reserveSnapshot(budget: SnapshotRetainedBudget, bytes: number): boolean {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.limit - budget.used) {
    return false;
  }
  budget.used += bytes;
  budget.peak = Math.max(budget.peak, budget.used);
  return true;
}

export function releaseSnapshot(budget: SnapshotRetainedBudget, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.used) {
    throw new CorruptError("commit tree snapshot retained accounting is invalid");
  }
  budget.used -= bytes;
}

export function inputError(message: string): GitError {
  return new GitError("EINVAL", message);
}

export function tooLarge(message: string): GitError {
  return new GitError("E2BIG", message);
}

export function validateRoot(root: string): void {
  if (root.charCodeAt(0) !== 0x2f) throw inputError("sparse workspace root is invalid");
  if (root === "/") return;
  if (root.charCodeAt(root.length - 1) === 0x2f) {
    throw inputError("sparse workspace root is invalid");
  }
  let bytes = 1;
  let segments = 0;
  let start = 1;
  for (let index = 1; index <= root.length; index++) {
    const unit = root.charCodeAt(index);
    if (index === root.length || unit === 0x2f) {
      const length = index - start;
      if (
        length === 0 ||
        (length === 1 && root.charCodeAt(start) === 0x2e) ||
        (length === 2 && root.charCodeAt(start) === 0x2e && root.charCodeAt(start + 1) === 0x2e)
      ) {
        throw inputError("sparse workspace root is invalid");
      }
      segments++;
      if (segments > MAX_ROOT_SEGMENTS) {
        throw tooLarge(`sparse workspace root exceeds ${MAX_ROOT_SEGMENTS} segments`);
      }
      start = index + 1;
      if (index !== root.length) bytes++;
    } else if (unit === 0) {
      throw inputError("sparse workspace root is invalid");
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = root.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) throw inputError("sparse workspace root is invalid");
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw inputError("sparse workspace root is invalid");
    } else if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
    if (!Number.isSafeInteger(bytes)) throw tooLarge("sparse workspace root size overflows");
  }
}

export function relativePathShape(path: string): { bytes: number; segments: number } {
  if (path === "" || path.startsWith("/") || path.endsWith("/")) {
    throw inputError("sparse workspace path is invalid");
  }
  let segments = 0;
  let bytes = 0;
  let start = 0;
  for (let index = 0; index <= path.length; index++) {
    const unit = path.charCodeAt(index);
    if (index === path.length || unit === 0x2f) {
      const length = index - start;
      if (
        length === 0 ||
        (length === 1 && path.charCodeAt(start) === 0x2e) ||
        (length === 2 && path.charCodeAt(start) === 0x2e && path.charCodeAt(start + 1) === 0x2e)
      ) {
        throw inputError("sparse workspace path is invalid");
      }
      segments++;
      start = index + 1;
      if (index !== path.length) bytes++;
    } else if (unit === 0) {
      throw inputError("sparse workspace path is invalid");
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = path.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) {
        throw inputError("sparse workspace path is invalid");
      }
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw inputError("sparse workspace path is invalid");
    } else if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
    if (!Number.isSafeInteger(bytes)) throw tooLarge("sparse workspace path size overflows");
  }
  return { bytes, segments };
}

export function parseRelativePath(path: string): { bytes: number; segments: string[] } {
  const shape = relativePathShape(path);
  return { bytes: shape.bytes, segments: path.split("/") };
}

export function validateRequest(
  request: SparseWorkspaceRequest,
  retainedLimit: number,
): ValidatedRequest {
  if (!Number.isSafeInteger(request.repoId) || request.repoId <= 0) {
    throw inputError("sparse workspace repository id is invalid");
  }
  if (!Number.isSafeInteger(request.checkoutId) || request.checkoutId <= 0) {
    throw inputError("sparse workspace checkout id is invalid");
  }
  validateRoot(request.root);
  if (
    (request.baselineTreeOid !== null && !isOid(request.baselineTreeOid)) ||
    (request.currentTreeOid !== null && !isOid(request.currentTreeOid))
  ) {
    throw inputError("sparse workspace tree oid is invalid");
  }
  if (request.paths.length > MAX_PATHS) {
    throw tooLarge(`sparse workspace request exceeds ${MAX_PATHS} paths`);
  }

  let retainedBytes = 0;
  let jsonBytes = 2;
  let jsonChars = 2;
  let previous: string | null = null;
  for (const path of request.paths) {
    const parsed = relativePathShape(path);
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("sparse workspace paths are not in strict Git order");
    }
    if (parsed.segments > MAX_DEPTH) {
      return { json: "", segments: [], retainedBytes: -1 };
    }
    const quoted = jsonQuotedSize(path);
    jsonBytes += quoted.bytes + (previous === null ? 0 : 1);
    jsonChars += quoted.chars + (previous === null ? 0 : 1);
    if (!Number.isSafeInteger(jsonBytes) || !Number.isSafeInteger(jsonChars)) {
      throw tooLarge("sparse workspace request JSON size overflows");
    }
    retainedBytes +=
      ROW_RETAINED_BYTES +
      path.length * 4 +
      parsed.bytes +
      parsed.segments * SEGMENT_RETAINED_BYTES;
    if (retainedBytes > retainedLimit) {
      return { json: "", segments: [], retainedBytes: -1 };
    }
    previous = path;
  }
  if (retainedBytes > retainedLimit - jsonChars * 2) {
    return { json: "", segments: [], retainedBytes: -1 };
  }
  retainedBytes += jsonChars * 2;
  const segments = request.paths.map((path) => path.split("/"));
  const json = JSON.stringify(request.paths);
  if (json.length !== jsonChars) {
    throw new CorruptError("sparse workspace request JSON size changed during construction");
  }
  return { json, segments, retainedBytes };
}

export function validateIndexAncestorRequest(input: unknown): {
  request: SparseIndexAncestorRequest;
  pathBytes: number[];
  json: string;
  retainedBytes: number;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw inputError("sparse index ancestor request is invalid");
  }
  const checkoutId = Reflect.get(input, "checkoutId");
  const ancestorsInput = Reflect.get(input, "ancestors");
  if (!Number.isSafeInteger(checkoutId) || typeof checkoutId !== "number" || checkoutId <= 0) {
    throw inputError("sparse index ancestor checkout id is invalid");
  }
  if (!Array.isArray(ancestorsInput)) {
    throw inputError("sparse index ancestor paths are invalid");
  }
  if (ancestorsInput.length > MAX_INDEX_ANCESTORS) {
    throw tooLarge(`sparse index ancestor request exceeds ${MAX_INDEX_ANCESTORS} paths`);
  }
  const ancestors: string[] = [];
  for (let index = 0; index < ancestorsInput.length; index++) {
    if (!Object.hasOwn(ancestorsInput, index)) {
      throw inputError("sparse index ancestor paths are not dense");
    }
    const path: unknown = Reflect.get(ancestorsInput, String(index));
    if (typeof path !== "string") {
      throw inputError("sparse index ancestor path is invalid");
    }
    ancestors.push(path);
  }
  const request: SparseIndexAncestorRequest = {
    checkoutId,
    ancestors,
  };
  const retainedLimit = SPARSE_WORKSPACE_STATE_BYTES;

  const parts: string[] = [];
  const pathBytes: number[] = [];
  let retainedBytes = 0;
  let jsonBytes = 2;
  let jsonChars = 2;
  let previous: string | null = null;
  for (const path of request.ancestors) {
    const parsed = parseRelativePath(path);
    if (parsed.segments.length > MAX_DEPTH) {
      throw tooLarge(`sparse index ancestor path exceeds ${MAX_DEPTH} segments`);
    }
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("sparse index ancestor paths are not in strict Git order");
    }
    const part = JSON.stringify(path);
    const separatorBytes = previous === null ? 0 : 1;
    const nextJsonBytes = jsonBytes + encoder.encode(part).length + separatorBytes;
    const nextJsonChars = jsonChars + part.length + separatorBytes;
    const nextRetainedBytes = retainedBytes + INDEX_ANCESTOR_RETAINED_BYTES + path.length * 4;
    if (!Number.isSafeInteger(nextJsonBytes) || !Number.isSafeInteger(nextJsonChars)) {
      throw tooLarge("sparse index ancestor request JSON size overflows");
    }
    if (nextRetainedBytes > retainedLimit - nextJsonChars * 2) {
      throw tooLarge(`sparse index ancestor retained state exceeds ${retainedLimit} bytes`);
    }
    parts.push(part);
    pathBytes.push(parsed.bytes);
    jsonBytes = nextJsonBytes;
    jsonChars = nextJsonChars;
    retainedBytes = nextRetainedBytes;
    previous = path;
  }
  const totalRetainedBytes = retainedBytes + jsonChars * 2;
  return {
    request,
    pathBytes,
    json: `[${parts.join(",")}]`,
    retainedBytes: totalRetainedBytes,
  };
}

export function jsonQuotedSize(value: string): { chars: number; bytes: number } {
  let chars = 2;
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (
      unit === 0x22 ||
      unit === 0x5c ||
      unit === 0x08 ||
      unit === 0x09 ||
      unit === 0x0a ||
      unit === 0x0c ||
      unit === 0x0d
    ) {
      chars += 2;
      bytes += 2;
    } else if (unit < 0x20) {
      chars += 6;
      bytes += 6;
    } else if (unit < 0x80) {
      chars++;
      bytes++;
    } else if (unit < 0x800) {
      chars++;
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      chars += 2;
      bytes += 4;
      index++;
    } else {
      chars++;
      bytes += 3;
    }
  }
  return { chars, bytes };
}
