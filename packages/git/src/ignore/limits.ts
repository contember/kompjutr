import type { RegularFileHandle } from "@kompjutr/drive";

export const IGNORE_LIMITS = {
  rawBytes: 1_000_000,
  fileBytes: 250_000,
  files: 1_024,
  /** Bounds retained compiled-rule memory against the 128 MiB isolate heap. */
  patterns: 8_192,
  queryBytes: 16_384,
  /** Matcher steps (~50 ms) that keep one query inside the DO request CPU limit. */
  requestCpuWork: 10_000_000,
  discoveryPage: 128,
};

export type IgnoreLimitResource =
  | "rawBytes"
  | "fileBytes"
  | "files"
  | "patterns"
  | "queryBytes"
  | "requestCpuWork";

/** A fail-closed resource limit from loading ignore rules. */
export class IgnoreLimitError extends Error {
  readonly code = "E2BIG";

  constructor(
    readonly resource: IgnoreLimitResource,
    readonly limit: number,
    readonly observed: number,
    readonly path?: string,
  ) {
    super(
      `E2BIG: .gitignore ${resource} exceeds ${limit}${path === undefined ? "" : ` at '${path}'`}`,
    );
    this.name = "IgnoreLimitError";
  }
}

export class IgnoreBudget {
  rawBytes = 0;
  files = 0;
  patterns = 0;

  addRaw(bytes: number, path?: string): void {
    const observed = this.rawBytes + bytes;
    if (observed > IGNORE_LIMITS.rawBytes) {
      throw new IgnoreLimitError("rawBytes", IGNORE_LIMITS.rawBytes, observed, path);
    }
    this.rawBytes = observed;
  }

  addFile(handle: RegularFileHandle): void {
    if (handle.size > IGNORE_LIMITS.fileBytes) {
      throw new IgnoreLimitError("fileBytes", IGNORE_LIMITS.fileBytes, handle.size, handle.path);
    }
    const observed = this.files + 1;
    if (observed > IGNORE_LIMITS.files) {
      throw new IgnoreLimitError("files", IGNORE_LIMITS.files, observed, handle.path);
    }
    this.files = observed;
    this.addRaw(handle.size, handle.path);
  }

  addPattern(path?: string): void {
    const observed = this.patterns + 1;
    if (observed > IGNORE_LIMITS.patterns) {
      throw new IgnoreLimitError("patterns", IGNORE_LIMITS.patterns, observed, path);
    }
    this.patterns = observed;
  }
}
