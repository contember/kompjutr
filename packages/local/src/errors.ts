import { GitError } from "@kompjutr/sqlite";

export interface LocalError extends Error {
  readonly code: string;
  readonly path?: string;
}

export function localError(code: string, message: string, path?: string): LocalError {
  const text = path === undefined ? message : `${code}: ${message}, '${path}'`;
  return path === undefined
    ? Object.assign(new Error(text), { code })
    : Object.assign(new Error(text), { code, path });
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export function normalizeHostError(error: unknown, operation: string, path?: string): never {
  const code = errorCode(error);
  if (code !== undefined) {
    const message = error instanceof Error ? error.message : `${operation} failed`;
    throw localError(code, message, path);
  }
  throw error;
}

export function unsupported(message: string): GitError {
  return new GitError("EUNSUPPORTED", message);
}
