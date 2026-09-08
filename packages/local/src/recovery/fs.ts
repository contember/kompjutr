import { closeSync, fsyncSync, lstatSync, openSync, renameSync, rmSync } from "node:fs";

import { errorCode, normalizeHostError } from "../errors.js";

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    normalizeHostError(error, "lstat", path);
  }
}

export function syncDirectory(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    normalizeHostError(error, "open directory for sync", path);
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    normalizeHostError(error, "sync directory", path);
  } finally {
    closeSync(fd);
  }
}

export function durableRename(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (error) {
    normalizeHostError(error, "rename", source);
  }
}

export function removePath(path: string): void {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch (error) {
    normalizeHostError(error, "remove recovery path", path);
  }
}
