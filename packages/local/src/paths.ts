import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RealPath } from "@kompjutr/drive";
import { errorCode, localError, normalizeHostError } from "./errors.js";

const MAX_SYMLINK_FOLLOWS = 40;
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function realPath(path: string): RealPath;
function realPath(path: string): string {
  return path;
}

function virtualPath(parts: readonly string[]): string {
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function components(path: string): string[] {
  const rooted = path.startsWith("/") ? path.replace(/^\/+/, "") : path;
  return rooted === "" ? [] : rooted.split("/");
}

function isWithin(root: string, target: string): boolean {
  const offset = relative(root, target);
  return (
    offset === "" || (offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
}

function requireDirectory(stat: Stats | undefined, source: string): void {
  if (stat !== undefined && !stat.isDirectory()) {
    throw localError("ENOTDIR", "path component is not a directory", source);
  }
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    normalizeHostError(error, "lstat", path);
  }
}

function decodeLink(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readlinkSync(path, { encoding: "buffer" });
  } catch (error) {
    normalizeHostError(error, "readlink", path);
  }
  try {
    return fatalDecoder.decode(bytes);
  } catch {
    throw localError("EILSEQ", "symbolic link target is not valid UTF-8", path);
  }
}

export function requireCanonicalAbsolutePath(path: string, label: string): void {
  if (
    !path.isWellFormed() ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (path !== "/" && path.endsWith("/"))
  ) {
    throw localError("EINVAL", `${label} must be a canonical absolute Unix path`, path);
  }
}

export function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

export function comparePaths(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    const leftPoint = a[index]?.codePointAt(0) ?? 0;
    const rightPoint = b[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return a.length - b.length;
}

export function virtualParent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

export function virtualDepth(path: string): number {
  return path === "/" ? 0 : path.split("/").length - 1;
}

export function virtualCovers(parent: string, child: string): boolean {
  return parent === "/" || parent === child || child.startsWith(`${parent}/`);
}

export function hasCoveringVirtualPath(paths: ReadonlySet<string>, path: string): boolean {
  let current = path;
  for (;;) {
    if (paths.has(current)) return true;
    if (current === "/") return false;
    current = virtualParent(current);
  }
}

export class PathMapper {
  readonly root: string;

  constructor(root: string) {
    requireCanonicalAbsolutePath(root, "root");
    let canonical: string;
    try {
      canonical = realpathSync.native(root);
    } catch (error) {
      normalizeHostError(error, "realpath", root);
    }
    if (canonical !== root) throw localError("EINVAL", "root must already be canonical", root);
    const stat = lstatIfPresent(root);
    if (stat === undefined || !stat.isDirectory()) {
      throw localError("ENOTDIR", "root must be an existing directory", root);
    }
    this.root = root;
  }

  resolve(path: string, followFinal = true): RealPath {
    if (!path.isWellFormed() || path.includes("\0")) {
      throw localError("EINVAL", "path is not a valid UTF-8 path", path);
    }
    let resolved: string[] = [];
    let pending = components(path);
    let follows = 0;
    let missingPrefix: string | undefined;

    for (;;) {
      let expanded = false;
      for (let index = 0; index < pending.length; index++) {
        const component = pending[index];
        if (component === undefined) continue;
        const currentHost = this.lexicalHost(virtualPath(resolved));
        requireDirectory(lstatIfPresent(currentHost), path);
        if (component === "" || component === ".") continue;
        if (component === "..") {
          if (missingPrefix !== undefined) {
            throw localError(
              "ENOENT",
              "path traverses upward through a missing component",
              missingPrefix,
            );
          }
          if (resolved.length === 0) {
            throw localError("EACCES", "path escapes the workspace root", path);
          }
          resolved.pop();
          continue;
        }

        resolved.push(component);
        const candidateVirtual = virtualPath(resolved);
        const candidateHost = this.lexicalHost(candidateVirtual);
        const stat = lstatIfPresent(candidateHost);
        if (stat === undefined && missingPrefix === undefined) missingPrefix = candidateVirtual;
        const isFinal = index === pending.length - 1;
        if (stat?.isSymbolicLink() !== true || (!followFinal && isFinal)) continue;
        if (follows >= MAX_SYMLINK_FOLLOWS) {
          throw localError("ELOOP", "too many symbolic links", path);
        }
        follows++;

        resolved.pop();
        const target = decodeLink(candidateHost);
        if (isAbsolute(target)) {
          const canonicalTarget = resolve(target);
          if (!isWithin(this.root, canonicalTarget)) {
            throw localError(
              "EACCES",
              "symbolic link escapes the workspace root",
              candidateVirtual,
            );
          }
          const targetRelative = relative(this.root, canonicalTarget);
          resolved = [];
          pending = [
            ...(targetRelative === "" ? [] : targetRelative.split(sep)),
            ...pending.slice(index + 1),
          ];
        } else {
          pending = [...components(target), ...pending.slice(index + 1)];
        }
        missingPrefix = undefined;
        expanded = true;
        break;
      }
      if (!expanded) return realPath(virtualPath(resolved));
    }
  }

  host(path: string, followFinal = true): string {
    return this.lexicalHost(this.resolve(path, followFinal));
  }

  lexicalHost(path: string): string {
    if (path === "/") return this.root;
    if (!path.startsWith("/") || !path.isWellFormed() || path.includes("\0")) {
      throw localError("EINVAL", "recovery path is not canonical", path);
    }
    const segments = path.slice(1).split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw localError("EINVAL", "recovery path is not canonical", path);
    }
    return join(this.root, ...segments);
  }

  virtual(host: string): RealPath {
    if (!host.isWellFormed() || host.includes("\0")) {
      throw localError("EINVAL", "host path is invalid", host);
    }
    const canonical = resolve(host);
    if (!isWithin(this.root, canonical)) {
      throw localError("EACCES", "host path escapes the workspace root", host);
    }
    const offset = relative(this.root, canonical);
    return realPath(offset === "" ? "/" : `/${offset.split(sep).join("/")}`);
  }
}
