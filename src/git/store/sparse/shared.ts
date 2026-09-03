import { isOid } from "../../common/bytes.js";
import { GitError } from "../../common/errors.js";
import { comparePaths } from "../../common/streams.js";
import type {
  SparseIndexAncestorRequest,
  SparseTreeLeaf,
  SparseWorkspaceRequest,
} from "../core/contracts.js";

export const MAX_PATHS = 1_000;
export const MAX_SPARSE_BINDING_BYTES = 8 * 1024 * 1024;
export const MAX_ROOT_SEGMENTS = 128;
export const MAX_DEPTH = 64;
export const MAX_EDGE_STEPS = 32_768;
export const MAX_INDEX_ANCESTORS = MAX_PATHS;
export const MAX_SELECTED_EXACT_ANCESTORS = 32_768;
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
}

export interface ValidatedTreeSource {
  sourceKey: number;
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
      if (next < 0xdc00 || next > 0xdfff) throw inputError("sparse workspace path is invalid");
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

export function validateRequest(request: SparseWorkspaceRequest): ValidatedRequest {
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
  const parts: string[] = [];
  const segments: string[][] = [];
  let jsonBytes = 2;
  let previous: string | null = null;
  for (const path of request.paths) {
    const parsed = parseRelativePath(path);
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("sparse workspace paths are not in strict Git order");
    }
    if (parsed.segments.length > MAX_DEPTH)
      throw tooLarge(`sparse workspace path exceeds ${MAX_DEPTH} segments`);
    const part = JSON.stringify(path);
    jsonBytes += encoder.encode(part).length + (previous === null ? 0 : 1);
    if (!Number.isSafeInteger(jsonBytes))
      throw tooLarge("sparse workspace request JSON size overflows");
    if (jsonBytes > MAX_SPARSE_BINDING_BYTES)
      throw tooLarge("sparse workspace request JSON is too large");
    parts.push(part);
    segments.push(parsed.segments);
    previous = path;
  }
  return { json: `[${parts.join(",")}]`, segments };
}

export function validateIndexAncestorRequest(input: unknown): {
  request: SparseIndexAncestorRequest;
  json: string;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw inputError("sparse index ancestor request is invalid");
  }
  const checkoutId = Reflect.get(input, "checkoutId");
  const ancestorsInput = Reflect.get(input, "ancestors");
  if (!Number.isSafeInteger(checkoutId) || typeof checkoutId !== "number" || checkoutId <= 0) {
    throw inputError("sparse index ancestor checkout id is invalid");
  }
  if (!Array.isArray(ancestorsInput)) throw inputError("sparse index ancestor paths are invalid");
  if (ancestorsInput.length > MAX_INDEX_ANCESTORS) {
    throw tooLarge(`sparse index ancestor request exceeds ${MAX_INDEX_ANCESTORS} paths`);
  }
  const ancestors: string[] = [];
  const parts: string[] = [];
  let jsonBytes = 2;
  let previous: string | null = null;
  for (let index = 0; index < ancestorsInput.length; index++) {
    if (!Object.hasOwn(ancestorsInput, index))
      throw inputError("sparse index ancestor paths are not dense");
    const path: unknown = Reflect.get(ancestorsInput, String(index));
    if (typeof path !== "string") throw inputError("sparse index ancestor path is invalid");
    const parsed = parseRelativePath(path);
    if (parsed.segments.length > MAX_DEPTH) {
      throw tooLarge(`sparse index ancestor path exceeds ${MAX_DEPTH} segments`);
    }
    if (previous !== null && comparePaths(previous, path) >= 0) {
      throw inputError("sparse index ancestor paths are not in strict Git order");
    }
    const part = JSON.stringify(path);
    jsonBytes += encoder.encode(part).length + (previous === null ? 0 : 1);
    if (!Number.isSafeInteger(jsonBytes))
      throw tooLarge("sparse index ancestor request JSON size overflows");
    if (jsonBytes > MAX_SPARSE_BINDING_BYTES)
      throw tooLarge("sparse index ancestor request JSON is too large");
    ancestors.push(path);
    parts.push(part);
    previous = path;
  }
  return {
    request: { checkoutId, ancestors },
    json: `[${parts.join(",")}]`,
  };
}
