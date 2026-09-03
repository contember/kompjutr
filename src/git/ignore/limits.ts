import type { RegularFileHandle } from "../../fs/types.js";
import { type IgnorePattern, patternLimits } from "./pattern.js";

export const IGNORE_LIMITS = {
  rawBytes: 1_000_000,
  fileBytes: 250_000,
  files: 1_024,
  patterns: 8_192,
  compiledBytes: 256_000,
  patternBytes: 4_096,
  nfaStates: 64,
  totalNfaStates: 4_096,
  wildcardSegments: 4_096,
  queryBytes: 16_384,
  querySegments: 128,
  matcherWork: 4_096,
  discoveryPage: 128,
};

export type IgnoreLimitResource =
  | "rawBytes"
  | "fileBytes"
  | "files"
  | "patterns"
  | "compiledBytes"
  | "patternBytes"
  | "nfaStates"
  | "totalNfaStates"
  | "wildcardSegments"
  | "queryBytes"
  | "querySegments"
  | "matcherWork";

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
  compiledBytes = 0;
  totalNfaStates = 0;
  wildcardSegments = 0;

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

  checkLine(bytes: number, path?: string): number {
    if (bytes > IGNORE_LIMITS.patternBytes) {
      throw new IgnoreLimitError("patternBytes", IGNORE_LIMITS.patternBytes, bytes, path);
    }
    return bytes;
  }

  addPattern(pattern: IgnorePattern, bytes: number, path?: string): void {
    const observed = this.patterns + 1;
    if (observed > IGNORE_LIMITS.patterns) {
      throw new IgnoreLimitError("patterns", IGNORE_LIMITS.patterns, observed, path);
    }
    this.patterns = observed;
    const compiledBytes = this.compiledBytes + bytes;
    if (compiledBytes > IGNORE_LIMITS.compiledBytes) {
      throw new IgnoreLimitError("compiledBytes", IGNORE_LIMITS.compiledBytes, compiledBytes, path);
    }
    this.compiledBytes = compiledBytes;
    const limits = patternLimits(pattern);
    if (limits.nfaStates > IGNORE_LIMITS.nfaStates) {
      throw new IgnoreLimitError("nfaStates", IGNORE_LIMITS.nfaStates, limits.nfaStates, path);
    }
    const totalNfaStates = this.totalNfaStates + limits.nfaStates;
    if (totalNfaStates > IGNORE_LIMITS.totalNfaStates) {
      throw new IgnoreLimitError(
        "totalNfaStates",
        IGNORE_LIMITS.totalNfaStates,
        totalNfaStates,
        path,
      );
    }
    this.totalNfaStates = totalNfaStates;
    const wildcardSegments = this.wildcardSegments + limits.wildcardSegments;
    if (wildcardSegments > IGNORE_LIMITS.wildcardSegments) {
      throw new IgnoreLimitError(
        "wildcardSegments",
        IGNORE_LIMITS.wildcardSegments,
        wildcardSegments,
        path,
      );
    }
    this.wildcardSegments = wildcardSegments;
  }
}
