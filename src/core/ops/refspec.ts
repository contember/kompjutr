import { isOid } from "../bytes.js";
import { CorruptError, GitError } from "../errors.js";
import { checkRefText, hasCanonicalRefSyntax, MAX_REF_NAME_BYTES } from "../ref-name.js";
import { retainedStringBytes } from "../retained.js";
import { comparePaths } from "../streams.js";
import type { TransportOperationBudget } from "./transport-budget.js";

export const MAX_REFSPEC_MAPPINGS = 1_024;
export const MAX_REFSPEC_EXPANDED_DESTINATIONS = 1_024;
export const MAX_REFSPEC_REF_BYTES = MAX_REF_NAME_BYTES;

export type RemoteTarget =
  | { readonly remote?: string; readonly url?: never }
  | { readonly remote?: never; readonly url: string };

export interface FetchRefspec {
  readonly source: string;
  readonly destination: string;
  readonly force?: boolean;
}

export type PushRefspec =
  | {
      readonly source: string;
      readonly destination: string;
      readonly force?: boolean;
    }
  | {
      readonly source: null;
      readonly destination: string;
      readonly force?: never;
    };

export interface RemoteRefView {
  readonly name: string;
  readonly oid: string;
}

export interface LsRemoteResult {
  readonly refs: readonly RemoteRefView[];
  readonly headRef: string | null;
}

export interface FetchRefUpdate {
  readonly source: string;
  readonly destination: string;
  readonly oid: string;
}

export type FetchResult =
  | {
      readonly mode: "legacy";
      readonly defaultBranch: string | null;
      readonly fetchHead: string | null;
      readonly updates: readonly [];
    }
  | {
      readonly mode: "mapped";
      readonly defaultBranch: string | null;
      readonly fetchHead: null;
      readonly updates: readonly FetchRefUpdate[];
    };

export interface PushRefStatus {
  readonly ref: string;
  readonly ok: boolean;
  readonly error: string | null;
}

export type PushTrackingResult =
  | { readonly outcome: "not-applicable" | "unchanged" | "updated" | "stale" | "deferred" }
  | { readonly outcome: "failed"; readonly code: string; readonly message: string };

export interface PushResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly unpack: { readonly ok: true } | { readonly ok: false; readonly error: string };
  readonly refs: readonly PushRefStatus[];
  readonly tracking: PushTrackingResult;
}

export interface RefspecSourceRef {
  readonly name: string;
  readonly oid: string;
}

export interface ExpandedFetchRefspec extends FetchRefUpdate {
  readonly force: boolean;
}

export interface ExpandedPushRefspec {
  readonly source: string | null;
  readonly destination: string;
  readonly oid: string | null;
  readonly force: boolean;
}

/** One authoritative local-expansion snapshot paired with the observed remote destination. */
export interface PushPlanningUpdate extends ExpandedPushRefspec {
  readonly oldOid: string;
}

interface CompiledMapping {
  readonly source: string | null;
  readonly destination: string;
  readonly sourceStar: number;
  readonly destinationStar: number;
  readonly oidSource: boolean;
  readonly force: boolean;
}

export interface CompiledFetchRefspecs {
  expand(refs: readonly RefspecSourceRef[]): readonly ExpandedFetchRefspec[];
  dispose(): void;
}

export interface CompiledPushRefspecs {
  expand(refs: readonly RefspecSourceRef[]): readonly ExpandedPushRefspec[];
  dispose(): void;
}

const COMPILED_MEMORY_PART = "refspec-compiled";
const EXPANDED_MEMORY_PART = "refspec-expanded";
const COMPILED_FIXED_BYTES = 192;
const MAPPING_FIXED_BYTES = 160;
const EXPANDED_FIXED_BYTES = 192;
const EXPANDED_MAPPING_FIXED_BYTES = 144;
const SOURCE_INDEX_FIXED_BYTES = 144;

function malformed(message: string): GitError {
  return new GitError("EINVAL", message);
}

function invalidRef(label: string): GitError {
  return new GitError("EINVALIDREF", `${label} is not a canonical full ref`);
}

function boundedRefText(value: string, label: string): void {
  const checked = checkRefText(value, MAX_REFSPEC_REF_BYTES);
  if (checked.problem === "too-long") {
    throw new GitError("E2BIG", `${label} exceeds ${MAX_REFSPEC_REF_BYTES} UTF-8 bytes`);
  }
  if (checked.problem !== null) throw invalidRef(label);
}

function requireFullRef(value: string, label: string): void {
  boundedRefText(value, label);
  if (!value.startsWith("refs/") || !hasCanonicalRefSyntax(value)) throw invalidRef(label);
}

function starIndex(value: string): number {
  const first = value.indexOf("*");
  if (first < 0) return -1;
  return value.indexOf("*", first + 1) < 0 ? first : -2;
}

function requirePattern(value: string, star: number, label: string): void {
  boundedRefText(value, label);
  if (star < 0) throw malformed(`${label} must contain exactly one wildcard`);
  const substituted = `${value.slice(0, star)}x${value.slice(star + 1)}`;
  if (!substituted.startsWith("refs/") || !hasCanonicalRefSyntax(substituted)) {
    throw invalidRef(label);
  }
}

function requireForce(force: boolean | undefined, label: string): boolean {
  if (force !== undefined && typeof force !== "boolean") {
    throw malformed(`${label} force must be boolean`);
  }
  return force === true;
}

function mappingBytes(source: string | null, destination: string): number {
  return (
    MAPPING_FIXED_BYTES +
    retainedStringBytes(destination) +
    (source === null ? 0 : retainedStringBytes(source))
  );
}

function validateMappingCount(refspecs: readonly unknown[]): void {
  if (refspecs.length === 0) throw malformed("refspec list must not be empty");
  if (refspecs.length > MAX_REFSPEC_MAPPINGS) {
    throw new GitError("E2BIG", `refspec list exceeds ${MAX_REFSPEC_MAPPINGS} mappings`);
  }
}

function compileMapping(
  source: string | null,
  destination: string,
  force: boolean,
  allowOid: boolean,
): CompiledMapping {
  if (typeof destination !== "string") throw malformed("refspec destination must be a string");
  if (source !== null && typeof source !== "string") {
    throw malformed("refspec source must be a string or null");
  }
  const sourceIsOid = source !== null && allowOid && isOid(source);
  const sourceStar = source === null || sourceIsOid ? -1 : starIndex(source);
  const destinationStar = starIndex(destination);

  if (source === null || sourceIsOid) {
    if (destinationStar !== -1) {
      throw malformed("deletion and object-id refspecs cannot contain wildcards");
    }
    requireFullRef(destination, "refspec destination");
  } else if (sourceStar === -1 && destinationStar === -1) {
    requireFullRef(source, "refspec source");
    requireFullRef(destination, "refspec destination");
  } else {
    if (sourceStar < 0 || destinationStar < 0) {
      throw malformed("transfer refspecs require exactly one wildcard on each side");
    }
    requirePattern(source, sourceStar, "refspec source pattern");
    requirePattern(destination, destinationStar, "refspec destination pattern");
  }

  return {
    source,
    destination,
    sourceStar,
    destinationStar,
    oidSource: sourceIsOid,
    force,
  };
}

function compile(
  refspecs: readonly FetchRefspec[] | readonly PushRefspec[],
  budget: TransportOperationBudget,
  direction: "fetch" | "push",
): CompiledMapping[] {
  validateMappingCount(refspecs);
  if (budget.memory(COMPILED_MEMORY_PART) !== 0 || budget.memory(EXPANDED_MEMORY_PART) !== 0) {
    throw malformed("transport operation already owns compiled refspec state");
  }
  let retained = COMPILED_FIXED_BYTES;
  budget.setMemory(COMPILED_MEMORY_PART, retained);
  const compiled: CompiledMapping[] = [];
  const exactDestinations = new Set<string>();
  try {
    for (let index = 0; index < refspecs.length; index++) {
      const refspec = refspecs[index];
      if (refspec === undefined || typeof refspec !== "object" || refspec === null) {
        throw malformed(`refspec ${index + 1} must be an object`);
      }
      const source = refspec.source;
      const destination = refspec.destination;
      const force = requireForce(refspec.force, `refspec ${index + 1}`);
      if (typeof destination !== "string") {
        throw malformed("refspec destination must be a string");
      }
      if (source !== null && typeof source !== "string") {
        throw malformed("refspec source must be a string or null");
      }
      if (direction === "fetch" && source === null) {
        throw malformed("fetch refspec source must be a string");
      }
      if (direction === "push" && source === null && refspec.force !== undefined) {
        throw malformed("deletion refspec cannot set force");
      }
      const additional = mappingBytes(source, destination);
      retained += additional;
      budget.setMemory(COMPILED_MEMORY_PART, retained);
      const mapping = compileMapping(source, destination, force, direction === "push");
      if (mapping.destinationStar < 0) {
        if (exactDestinations.has(mapping.destination)) {
          throw malformed(`duplicate exact refspec destination ${mapping.destination}`);
        }
        exactDestinations.add(mapping.destination);
      }
      compiled.push(mapping);
    }
    return compiled;
  } catch (error) {
    budget.clearMemory(COMPILED_MEMORY_PART);
    throw error;
  }
}

function actualSourceRefs(
  refs: readonly RefspecSourceRef[],
  expansion: ExpansionBudget,
): Map<string, string> {
  const actual = new Map<string, string>();
  const seen = new Set<string>();
  for (const ref of refs) {
    if (typeof ref.name !== "string" || typeof ref.oid !== "string" || !isOid(ref.oid)) {
      throw new CorruptError("refspec source set contains a malformed row");
    }
    const checked = checkRefText(ref.name, MAX_REFSPEC_REF_BYTES);
    if (checked.problem !== null) throw new CorruptError(`invalid refspec source ${ref.name}`);
    let metadata = ref.name === "HEAD";
    if (ref.name.endsWith("^{}")) {
      const base = ref.name.slice(0, -3);
      if (!base.startsWith("refs/tags/") || !hasCanonicalRefSyntax(base)) {
        throw new CorruptError(`invalid peeled refspec source ${ref.name}`);
      }
      metadata = true;
    } else if (!metadata && (!ref.name.startsWith("refs/") || !hasCanonicalRefSyntax(ref.name))) {
      throw new CorruptError(`invalid refspec source ${ref.name}`);
    }
    if (seen.has(ref.name)) throw new CorruptError(`duplicate refspec source ${ref.name}`);
    expansion.addSource(ref.name);
    seen.add(ref.name);
    if (metadata) continue;
    actual.set(ref.name, ref.oid);
  }
  return actual;
}

function wildcardCapture(source: string, pattern: string, star: number): string | null {
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return null;
  if (source.length < prefix.length + suffix.length) return null;
  return source.slice(prefix.length, source.length - suffix.length);
}

function substitute(pattern: string, star: number, capture: string): string {
  return `${pattern.slice(0, star)}${capture}${pattern.slice(star + 1)}`;
}

function requireExpandedDestination(value: string): void {
  const checked = checkRefText(value, MAX_REFSPEC_REF_BYTES);
  if (checked.problem === "too-long") {
    throw new GitError(
      "E2BIG",
      `expanded refspec destination exceeds ${MAX_REFSPEC_REF_BYTES} UTF-8 bytes`,
    );
  }
  if (checked.problem !== null || !value.startsWith("refs/") || !hasCanonicalRefSyntax(value)) {
    throw invalidRef("expanded refspec destination");
  }
}

function expandedBytes(source: string | null, destination: string, oid: string | null): number {
  return (
    EXPANDED_MAPPING_FIXED_BYTES +
    retainedStringBytes(destination) +
    (source === null ? 0 : retainedStringBytes(source)) +
    (oid === null ? 0 : retainedStringBytes(oid))
  );
}

class ExpansionBudget {
  #retained = EXPANDED_FIXED_BYTES;
  #destinations = 0;

  constructor(private readonly budget: TransportOperationBudget) {
    budget.setMemory(EXPANDED_MEMORY_PART, this.#retained);
  }

  addSource(name: string): void {
    this.#retained += SOURCE_INDEX_FIXED_BYTES + retainedStringBytes(name);
    this.budget.setMemory(EXPANDED_MEMORY_PART, this.#retained);
  }

  add(source: string | null, destination: string, oid: string | null): void {
    if (this.#destinations >= MAX_REFSPEC_EXPANDED_DESTINATIONS) {
      throw new GitError(
        "E2BIG",
        `expanded refspec set exceeds ${MAX_REFSPEC_EXPANDED_DESTINATIONS} destinations`,
      );
    }
    this.#retained += expandedBytes(source, destination, oid);
    this.budget.setMemory(EXPANDED_MEMORY_PART, this.#retained);
    this.#destinations++;
  }
}

function destinationGuard(seen: Set<string>, destination: string): void {
  if (seen.has(destination)) {
    throw malformed(`expanded refspecs have duplicate destination ${destination}`);
  }
  seen.add(destination);
}

class FetchCompiler implements CompiledFetchRefspecs {
  #active = true;

  constructor(
    private readonly mappings: readonly CompiledMapping[],
    private readonly budget: TransportOperationBudget,
  ) {}

  expand(refs: readonly RefspecSourceRef[]): readonly ExpandedFetchRefspec[] {
    if (!this.#active) throw malformed("compiled fetch refspecs are disposed");
    if (this.budget.memory(EXPANDED_MEMORY_PART) !== 0) {
      throw malformed("fetch refspecs have already been expanded");
    }
    try {
      const expansion = new ExpansionBudget(this.budget);
      const sources = actualSourceRefs(refs, expansion);
      const seen = new Set<string>();
      const result: ExpandedFetchRefspec[] = [];
      for (const mapping of this.mappings) {
        const source = mapping.source;
        if (source === null) throw new Error("compiled fetch deletion is impossible");
        if (mapping.sourceStar < 0) {
          const oid = sources.get(source);
          if (oid === undefined) {
            throw new GitError("EREFNOTFOUND", `remote ref not found: ${source}`);
          }
          destinationGuard(seen, mapping.destination);
          expansion.add(source, mapping.destination, oid);
          result.push({
            source,
            destination: mapping.destination,
            oid,
            force: mapping.force,
          });
          continue;
        }
        for (const [name, oid] of sources) {
          const capture = wildcardCapture(name, source, mapping.sourceStar);
          if (capture === null) continue;
          const destination = substitute(mapping.destination, mapping.destinationStar, capture);
          requireExpandedDestination(destination);
          destinationGuard(seen, destination);
          expansion.add(name, destination, oid);
          result.push({ source: name, destination, oid, force: mapping.force });
        }
      }
      result.sort((left, right) => comparePaths(left.destination, right.destination));
      return result;
    } catch (error) {
      this.budget.clearMemory(EXPANDED_MEMORY_PART);
      throw error;
    }
  }

  dispose(): void {
    if (!this.#active) return;
    this.budget.clearMemory(EXPANDED_MEMORY_PART);
    this.budget.clearMemory(COMPILED_MEMORY_PART);
    this.#active = false;
  }
}

class PushCompiler implements CompiledPushRefspecs {
  #active = true;

  constructor(
    private readonly mappings: readonly CompiledMapping[],
    private readonly budget: TransportOperationBudget,
  ) {}

  expand(refs: readonly RefspecSourceRef[]): readonly ExpandedPushRefspec[] {
    if (!this.#active) throw malformed("compiled push refspecs are disposed");
    if (this.budget.memory(EXPANDED_MEMORY_PART) !== 0) {
      throw malformed("push refspecs have already been expanded");
    }
    try {
      const expansion = new ExpansionBudget(this.budget);
      const sources = actualSourceRefs(refs, expansion);
      const seen = new Set<string>();
      const result: ExpandedPushRefspec[] = [];
      for (const mapping of this.mappings) {
        const source = mapping.source;
        if (source === null) {
          destinationGuard(seen, mapping.destination);
          expansion.add(null, mapping.destination, null);
          result.push({
            source: null,
            destination: mapping.destination,
            oid: null,
            force: false,
          });
          continue;
        }
        if (mapping.oidSource) {
          destinationGuard(seen, mapping.destination);
          expansion.add(source, mapping.destination, source);
          result.push({
            source,
            destination: mapping.destination,
            oid: source,
            force: mapping.force,
          });
          continue;
        }
        if (mapping.sourceStar < 0) {
          const oid = sources.get(source);
          if (oid === undefined) {
            throw new GitError("EREFNOTFOUND", `local ref not found: ${source}`);
          }
          destinationGuard(seen, mapping.destination);
          expansion.add(source, mapping.destination, oid);
          result.push({
            source,
            destination: mapping.destination,
            oid,
            force: mapping.force,
          });
          continue;
        }
        for (const [name, oid] of sources) {
          const capture = wildcardCapture(name, source, mapping.sourceStar);
          if (capture === null) continue;
          const destination = substitute(mapping.destination, mapping.destinationStar, capture);
          requireExpandedDestination(destination);
          destinationGuard(seen, destination);
          expansion.add(name, destination, oid);
          result.push({ source: name, destination, oid, force: mapping.force });
        }
      }
      result.sort((left, right) => comparePaths(left.destination, right.destination));
      return result;
    } catch (error) {
      this.budget.clearMemory(EXPANDED_MEMORY_PART);
      throw error;
    }
  }

  dispose(): void {
    if (!this.#active) return;
    this.budget.clearMemory(EXPANDED_MEMORY_PART);
    this.budget.clearMemory(COMPILED_MEMORY_PART);
    this.#active = false;
  }
}

export function compileFetchRefspecs(
  refspecs: readonly FetchRefspec[],
  budget: TransportOperationBudget,
): CompiledFetchRefspecs {
  return new FetchCompiler(compile(refspecs, budget, "fetch"), budget);
}

export function compilePushRefspecs(
  refspecs: readonly PushRefspec[],
  budget: TransportOperationBudget,
): CompiledPushRefspecs {
  return new PushCompiler(compile(refspecs, budget, "push"), budget);
}
