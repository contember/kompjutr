import type { Workspace } from "@kompjutr/do";
import { normalize } from "../../../packages/do/src/fs/path.js";
import { MAX_EDITOR_BYTES, REPO } from "../shared/protocol.js";

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function workspacePath(path: string): string {
  const absolute = path === "" ? REPO : `${REPO}/${path}`;
  if (normalize(absolute) !== absolute || !path.isWellFormed()) {
    throw new RequestError("EINVAL", "Expected a repository-relative canonical path");
  }
  return absolute;
}

export function resolvedPath(workspace: Workspace, path: string): string {
  const real = workspace.filesystem.realpath(workspacePath(path));
  if (real !== REPO && !real.startsWith(`${REPO}/`)) {
    throw new RequestError("EACCES", "Path resolves outside the repository");
  }
  return real;
}

export function readDocument(workspace: Workspace, path: string) {
  const absolute = resolvedPath(workspace, path);
  const stat = workspace.filesystem.stat(absolute);
  if (stat === null) throw new RequestError("ENOENT", "File no longer exists", 404);
  if (stat.type !== "file") throw new RequestError("EINVAL", "Only regular files can be edited");
  if (stat.size > MAX_EDITOR_BYTES) {
    throw new RequestError("EFBIG", "Editor supports files up to 512 KiB; use the terminal");
  }
  const bytes = workspace.filesystem.readFile(absolute);
  if (bytes.includes(0)) throw new RequestError("EUNSUPPORTED", "Binary file; use the terminal");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new RequestError("EUNSUPPORTED", "File is not UTF-8 text; use the terminal");
  }
  return { path, text, version: `${stat.ino}:${stat.rev}`, bytes: bytes.byteLength };
}

export function saveDocument(workspace: Workspace, path: string, text: string, version: string) {
  return workspace.db.transactionSync(() => {
    const current = readDocument(workspace, path);
    if (current.version !== version) {
      throw new RequestError("ESTALE", "File changed on the server. Reload it before saving.", 409);
    }
    if (!text.isWellFormed()) throw new RequestError("EINVAL", "Text is not well-formed UTF-8");
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAX_EDITOR_BYTES)
      throw new RequestError("EFBIG", "File exceeds 512 KiB");
    workspace.filesystem.writeFile(resolvedPath(workspace, path), bytes);
    return readDocument(workspace, path);
  });
}
