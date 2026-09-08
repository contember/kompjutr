// SPDX-License-Identifier: LGPL-2.1-or-later
//
// Ported from Git's xdiff/xmerge.c at 94f057755b7941b321fd11fec1b2e3ca5313a4e0
// (v2.54.0). LibXDiff is Copyright (C) 2003-2006 Davide Libenzi and
// Johannes E. Schindelin. LGPL-2.1-or-later, like the original.

import { GitError } from "../common/errors.js";
import type { ByteRecord } from "./myers.js";
import { checkedSum, tooBig } from "./xmerge-helpers.js";
import {
  DEFAULT_MARKER_SIZE,
  DEFAULT_TEXT_MERGE_LIMITS,
  type InputInfo,
  type ResolvedOptions,
  type TextMergeLimits,
  type TextMergeOptions,
} from "./xmerge-types.js";

export function resolveOptions(options: TextMergeOptions): ResolvedOptions {
  const limits: TextMergeLimits = {
    maxInputBytes: cappedLimit(
      "maxInputBytes",
      options.limits?.maxInputBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxInputBytes,
    ),
    maxTotalInputBytes: cappedLimit(
      "maxTotalInputBytes",
      options.limits?.maxTotalInputBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxTotalInputBytes,
    ),
    maxLineBytes: cappedLimit(
      "maxLineBytes",
      options.limits?.maxLineBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxLineBytes,
    ),
    maxLines: cappedLimit("maxLines", options.limits?.maxLines, DEFAULT_TEXT_MERGE_LIMITS.maxLines),
    maxChanges: cappedLimit(
      "maxChanges",
      options.limits?.maxChanges,
      DEFAULT_TEXT_MERGE_LIMITS.maxChanges,
    ),
    maxConflicts: cappedLimit(
      "maxConflicts",
      options.limits?.maxConflicts,
      DEFAULT_TEXT_MERGE_LIMITS.maxConflicts,
    ),
    maxConflictBytes: cappedLimit(
      "maxConflictBytes",
      options.limits?.maxConflictBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxConflictBytes,
    ),
    maxLabelBytes: cappedLimit(
      "maxLabelBytes",
      options.limits?.maxLabelBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxLabelBytes,
    ),
    maxMarkerSize: cappedLimit(
      "maxMarkerSize",
      options.limits?.maxMarkerSize,
      DEFAULT_TEXT_MERGE_LIMITS.maxMarkerSize,
    ),
    maxOutputBytes: cappedLimit(
      "maxOutputBytes",
      options.limits?.maxOutputBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxOutputBytes,
    ),
    maxMemoryBytes: cappedLimit(
      "maxMemoryBytes",
      options.limits?.maxMemoryBytes,
      DEFAULT_TEXT_MERGE_LIMITS.maxMemoryBytes,
    ),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new GitError("EINVAL", `text merge ${name} must be a non-negative safe integer`);
    }
  }
  const style = options.style ?? "merge";
  const refinement = options.refinement ?? "zealous-alnum";
  if (style !== "merge" && style !== "diff3" && style !== "zdiff3") {
    throw new GitError("EINVAL", `unknown text merge style: ${style}`);
  }
  if (refinement !== "eager" && refinement !== "zealous" && refinement !== "zealous-alnum") {
    throw new GitError("EINVAL", `unknown text merge refinement: ${refinement}`);
  }
  const markerSize = options.markerSize ?? DEFAULT_MARKER_SIZE;
  if (!Number.isSafeInteger(markerSize) || markerSize <= 0) {
    throw new GitError("EINVAL", "text merge marker size must be a positive safe integer");
  }
  if (markerSize > limits.maxMarkerSize)
    throw tooBig("text merge marker size", limits.maxMarkerSize);
  return {
    style,
    refinement,
    markerSize,
    indentHeuristic: options.indentHeuristic === true,
    labels: {
      current: encodeLabel(options.labels?.current, "current", limits.maxLabelBytes),
      base: encodeLabel(options.labels?.base, "base", limits.maxLabelBytes),
      incoming: encodeLabel(options.labels?.incoming, "incoming", limits.maxLabelBytes),
    },
    limits,
  };
}

function cappedLimit(name: string, value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GitError("EINVAL", `text merge ${name} must be a non-negative safe integer`);
  }
  if (value > ceiling) {
    throw new GitError("EINVAL", `text merge ${name} exceeds its hard ceiling of ${ceiling}`);
  }
  return value;
}

function encodeLabel(label: string | undefined, role: string, limit: number): Uint8Array | null {
  if (label === undefined) return null;
  let bytes = 0;
  for (let index = 0; index < label.length; index++) {
    const unit = label.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      throw new GitError("EINVAL", `text merge ${role} label contains a structural control byte`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = label.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new GitError("EINVAL", `text merge ${role} label contains an unpaired surrogate`);
      }
      bytes += 4;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", `text merge ${role} label contains an unpaired surrogate`);
    } else if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else bytes += 3;
    if (bytes > limit) throw tooBig(`text merge ${role} label`, limit);
  }
  return new TextEncoder().encode(label);
}

export function validateAndScanInputs(
  base: Uint8Array,
  current: Uint8Array,
  incoming: Uint8Array,
  limits: TextMergeLimits,
): InputInfo[] {
  const inputs = [base, current, incoming];
  for (const input of inputs) {
    if (input.length > limits.maxInputBytes) throw tooBig("text merge input", limits.maxInputBytes);
  }
  const total = checkedSum(
    inputs.map((input) => input.length),
    "input",
  );
  if (total > limits.maxTotalInputBytes) {
    throw tooBig("text merge total input", limits.maxTotalInputBytes);
  }
  const infos = inputs.map(scanInput);
  const lines = checkedSum(
    infos.map((info) => info.lines),
    "line count",
  );
  if (lines > limits.maxLines) throw tooBig("text merge line count", limits.maxLines);
  for (const info of infos) {
    if (info.maxLineBytes > limits.maxLineBytes) {
      throw tooBig("text merge line", limits.maxLineBytes);
    }
  }
  return infos;
}

function scanInput(input: Uint8Array): InputInfo {
  let lines = 0;
  let start = 0;
  let maxLineBytes = 0;
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== 0x0a) continue;
    lines++;
    maxLineBytes = Math.max(maxLineBytes, index + 1 - start);
    start = index + 1;
  }
  if (start < input.length) {
    lines++;
    maxLineBytes = Math.max(maxLineBytes, input.length - start);
  }
  return { lines, maxLineBytes };
}

export function splitByteRecords(bytes: Uint8Array): ByteRecord[] {
  if (bytes.length === 0) return [];
  const records: ByteRecord[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0x0a) continue;
    records.push({ bytes, start, end: index + 1 });
    start = index + 1;
  }
  if (start < bytes.length) records.push({ bytes, start, end: bytes.length });
  return records;
}
