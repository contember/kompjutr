import { utf8 } from "../common/bytes.js";
import { GitError } from "../common/errors.js";
import { checkRefText } from "../common/ref-name.js";
import { discover, MAX_PROTOCOL_NEGOTIATION_ENTRIES, type RemoteRef } from "../protocol/remote.js";
import { type GitAuth, RemoteAuthSession } from "../protocol/transport.js";
import type { GitContext } from "./context.js";
import { type RemoteAuthOptions, remoteUrlFor, validateRemoteAuthOptions } from "./network.js";
import type { LsRemoteResult, RemoteTarget } from "./refspec.js";
import type { Repository } from "./repository.js";

export const MAX_LS_REMOTE_PATTERNS = 1_024;
export const MAX_LS_REMOTE_REFS = MAX_PROTOCOL_NEGOTIATION_ENTRIES;

export type LsRemoteOptions = RemoteAuthOptions &
  RemoteTarget & {
    readonly patterns?: readonly string[];
  };

interface ByteRange {
  readonly first: number;
  readonly last: number;
}

type MatchToken =
  | { readonly kind: "literal"; readonly byte: number }
  | { readonly kind: "star" }
  | { readonly kind: "question" }
  | { readonly kind: "class"; readonly negated: boolean; readonly ranges: readonly ByteRange[] };

interface CompiledPattern {
  readonly tokens: readonly MatchToken[];
}

interface ClassAtom {
  readonly byte: number;
  readonly next: number;
}

function invalidPattern(index: number, message: string): GitError {
  return new GitError("EINVAL", `ls-remote pattern ${index + 1} ${message}`);
}

function readClassAtom(bytes: Uint8Array, index: number, patternIndex: number): ClassAtom {
  const byte = bytes[index];
  if (byte === undefined) throw invalidPattern(patternIndex, "has an unclosed bracket set");
  if (byte !== 0x5c) return { byte, next: index + 1 };
  const escaped = bytes[index + 1];
  if (escaped === undefined) throw invalidPattern(patternIndex, "has a trailing escape");
  return { byte: escaped, next: index + 2 };
}

function compileClass(
  bytes: Uint8Array,
  opening: number,
  patternIndex: number,
): { readonly token: MatchToken; readonly next: number } {
  let cursor = opening + 1;
  let negated = false;
  if (bytes[cursor] === 0x21 || bytes[cursor] === 0x5e) {
    negated = true;
    cursor++;
  }

  const ranges: ByteRange[] = [];
  let first = true;
  for (;;) {
    const byte = bytes[cursor];
    if (byte === undefined) throw invalidPattern(patternIndex, "has an unclosed bracket set");
    if (byte === 0x5d && !first) {
      return { token: { kind: "class", negated, ranges }, next: cursor + 1 };
    }

    const start = readClassAtom(bytes, cursor, patternIndex);
    cursor = start.next;
    if (bytes[cursor] === 0x2d && bytes[cursor + 1] !== undefined && bytes[cursor + 1] !== 0x5d) {
      const end = readClassAtom(bytes, cursor + 1, patternIndex);
      ranges.push({ first: start.byte, last: end.byte });
      cursor = end.next;
    } else {
      ranges.push({ first: start.byte, last: start.byte });
    }
    first = false;
  }
}

function compilePattern(pattern: string, index: number): CompiledPattern {
  const bytes = utf8.encode(pattern);
  const tokens: MatchToken[] = [];
  for (let cursor = 0; cursor < bytes.length; ) {
    const byte = bytes[cursor];
    if (byte === undefined) break;
    if (byte === 0x2a) {
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
      cursor++;
      continue;
    }
    if (byte === 0x3f) {
      tokens.push({ kind: "question" });
      cursor++;
      continue;
    }
    if (byte === 0x5b) {
      const compiled = compileClass(bytes, cursor, index);
      tokens.push(compiled.token);
      cursor = compiled.next;
      continue;
    }
    if (byte === 0x5c) {
      const escaped = bytes[cursor + 1];
      if (escaped === undefined) throw invalidPattern(index, "has a trailing escape");
      tokens.push({ kind: "literal", byte: escaped });
      cursor += 2;
      continue;
    }
    tokens.push({ kind: "literal", byte });
    cursor++;
  }
  return { tokens };
}

function compilePatterns(patterns: readonly string[] | undefined): readonly CompiledPattern[] {
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns)) throw new GitError("EINVAL", "ls-remote patterns must be an array");
  if (patterns.length === 0) return [];
  if (patterns.length > MAX_LS_REMOTE_PATTERNS) {
    throw new GitError("E2BIG", `ls-remote patterns exceed ${MAX_LS_REMOTE_PATTERNS} entries`);
  }

  const compiled: CompiledPattern[] = [];
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index];
    if (typeof pattern !== "string") throw invalidPattern(index, "must be a string");
    const checked = checkRefText(pattern);
    if (checked.problem !== null) throw invalidPattern(index, "contains invalid text");
    compiled.push(compilePattern(pattern, index));
  }
  return compiled;
}

function classMatches(
  token: Extract<MatchToken, { readonly kind: "class" }>,
  byte: number,
): boolean {
  let included = false;
  for (const range of token.ranges) {
    if (range.first <= byte && byte <= range.last) {
      included = true;
      break;
    }
  }
  return token.negated ? !included : included;
}

function tokenMatches(token: MatchToken, byte: number): boolean {
  if (token.kind === "literal") return token.byte === byte;
  if (token.kind === "question") return true;
  if (token.kind === "class") return classMatches(token, byte);
  return false;
}

function matchesFrom(pattern: CompiledPattern, candidate: Uint8Array, start: number): boolean {
  let tokenIndex = 0;
  let candidateIndex = start;
  let starIndex = -1;
  let starCandidateIndex = -1;

  while (candidateIndex < candidate.length) {
    const token = pattern.tokens[tokenIndex];
    const byte = candidate[candidateIndex];
    if (token?.kind === "star") {
      starIndex = tokenIndex;
      tokenIndex++;
      starCandidateIndex = candidateIndex;
      continue;
    }
    if (token !== undefined && byte !== undefined && tokenMatches(token, byte)) {
      tokenIndex++;
      candidateIndex++;
      continue;
    }
    if (starIndex >= 0) {
      starCandidateIndex++;
      candidateIndex = starCandidateIndex;
      tokenIndex = starIndex + 1;
      continue;
    }
    return false;
  }

  while (pattern.tokens[tokenIndex]?.kind === "star") tokenIndex++;
  return tokenIndex === pattern.tokens.length;
}

function patternMatchesRef(pattern: CompiledPattern, candidate: Uint8Array): boolean {
  if (matchesFrom(pattern, candidate, 0)) return true;
  for (let index = 0; index < candidate.length; index++) {
    if (candidate[index] === 0x2f && matchesFrom(pattern, candidate, index + 1)) return true;
  }
  return false;
}

function selectRefs(
  refs: readonly RemoteRef[],
  patterns: readonly CompiledPattern[],
): readonly RemoteRef[] {
  const selected: RemoteRef[] = [];
  for (const ref of refs) {
    if (patterns.length > 0) {
      const candidate = utf8.encode(ref.name);
      if (!patterns.some((pattern) => patternMatchesRef(pattern, candidate))) continue;
    }
    if (selected.length >= MAX_LS_REMOTE_REFS) {
      throw new GitError("E2BIG", `ls-remote result exceeds ${MAX_LS_REMOTE_REFS} refs`);
    }
    selected.push({ name: ref.name, oid: ref.oid });
  }
  return selected;
}

function resolveRemoteUrl(repo: Repository, options: LsRemoteOptions): string {
  if (options.remote !== undefined && options.url !== undefined) {
    throw new GitError("EINVAL", "ls-remote accepts either remote or url, not both");
  }
  if (options.url !== undefined) {
    if (typeof options.url !== "string")
      throw new GitError("EINVAL", "ls-remote url must be a string");
    return options.url;
  }
  if (
    options.remote !== undefined &&
    (typeof options.remote !== "string" || options.remote === "")
  ) {
    throw new GitError("EINVAL", "ls-remote remote must be a non-empty string");
  }
  const remote = options.remote ?? "origin";
  const url = remoteUrlFor(repo, remote);
  if (url === undefined) throw new GitError("ENOREMOTE", `no such remote: ${remote}`);
  return url;
}

function validateHeaders(
  headers: Record<string, string> | undefined,
  code: "EAUTH" | "EINVAL",
): void {
  if (headers === undefined) return;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new GitError(code, "remote authentication headers must be a string record");
  }
  for (const value of Object.values(headers)) {
    if (typeof value !== "string") {
      throw new GitError(code, "remote authentication headers must contain strings");
    }
  }
}

function validateCredentials(credentials: GitAuth | undefined): void {
  if (credentials === undefined) return;
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    throw new GitError("EAUTH", "remote authentication callback returned invalid credentials");
  }
  if (credentials.username !== undefined && typeof credentials.username !== "string") {
    throw new GitError("EAUTH", "remote authentication username must be a string");
  }
  if (credentials.password !== undefined && typeof credentials.password !== "string") {
    throw new GitError("EAUTH", "remote authentication password must be a string");
  }
  validateHeaders(credentials.headers, "EAUTH");
}

async function discoverRefs(context: GitContext, url: string, options: LsRemoteOptions) {
  validateHeaders(options.headers, "EINVAL");
  const onAuth = options.onAuth;
  const auth = {
    ...(context.http === undefined ? {} : { http: context.http }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(onAuth === undefined
      ? {}
      : {
          onAuth: async (...input: Parameters<typeof onAuth>) => {
            let credentials: GitAuth | undefined;
            try {
              credentials = await onAuth(...input);
            } catch (cause) {
              throw new GitError("EAUTH", "remote authentication callback failed", { cause });
            }
            validateCredentials(credentials);
            return credentials;
          },
        }),
    authSession: new RemoteAuthSession(),
  };
  try {
    return await discover(url, "git-upload-pack", auth);
  } catch (error) {
    if (isPublicDiscoveryError(error)) throw error;
    throw new GitError("EHTTP", "upload-pack discovery request failed", { cause: error });
  }
}

function isPublicDiscoveryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (
    error.code === "EHTTP" ||
    error.code === "EFETCHFAIL" ||
    error.code === "ECORRUPT" ||
    error.code === "E2BIG" ||
    error.code === "EAUTH" ||
    error.code === "EURLSCHEME"
  );
}

/** Read and project one validated upload-pack advertisement without repository mutation. */
export async function lsRemote(
  context: GitContext,
  repo: Repository,
  options: LsRemoteOptions = {},
): Promise<LsRemoteResult> {
  validateRemoteAuthOptions(options);
  const patterns = compilePatterns(options.patterns);
  const url = resolveRemoteUrl(repo, options);
  const advertisement = await discoverRefs(context, url, options);
  return {
    refs: selectRefs(advertisement.refs, patterns),
    headRef: advertisement.headRef,
  };
}
