import { serveGitRequest, validateServerOptions } from "./ops/server/http.js";
import type { GitServerOptions } from "./ops/server/runtime.js";
import type { SharedRepoStore } from "./store/index.js";

export type { GitServerOptions } from "./ops/server/runtime.js";

export interface GitServer {
  /** The caller authorizes repository read/write access and maps its mount to fixed Git paths. */
  fetch(request: Request): Promise<Response>;
}

/** Bind one validated bare repository identity; request URLs never select a repository. */
export function createGitServer(store: SharedRepoStore, options: GitServerOptions): GitServer {
  validateServerOptions(store, options);
  const settings = { ...options };
  return { fetch: (request) => serveGitRequest(store, settings, request) };
}
