import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";

import { localError, normalizeHostError } from "../errors.js";

const CHECKSUM_BYTES = 32;
const FRAME_HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_JOURNAL_RECORDS = 100_000;
export const MAX_RECOVERY_ACTIONS = 100_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export interface InitialRecord {
  readonly kind: "initial";
  readonly sequence: 0;
  readonly version: 1;
  readonly transaction: string;
  readonly baseGeneration: number;
  readonly targetGeneration: number;
}

export interface ProbeRecord {
  readonly kind: "probe";
  readonly sequence: number;
  readonly parent: string;
  readonly origin: string;
  readonly destination: string;
}

export interface TouchRecord {
  readonly path: string;
  readonly backup: string | null;
}

export interface ApplicationRecord {
  readonly kind: "application";
  readonly sequence: number;
  readonly touches: readonly TouchRecord[];
}

export interface TemporaryRecord {
  readonly kind: "temporary";
  readonly sequence: number;
  readonly parent: string;
  readonly name: string;
}

export type JournalRecord = InitialRecord | ProbeRecord | ApplicationRecord | TemporaryRecord;
export type AppendRecord =
  | InitialRecord
  | Omit<ProbeRecord, "sequence">
  | Omit<ApplicationRecord, "sequence">
  | Omit<TemporaryRecord, "sequence">;

export interface RecoveryManifest {
  readonly initial: InitialRecord;
  readonly probes: readonly ProbeRecord[];
  readonly touches: readonly TouchRecord[];
  readonly temporaries: readonly TemporaryRecord[];
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw localError("ECORRUPT", `${label} contains duplicates`);
  }
}

export function validateRecoveryManifest(manifest: RecoveryManifest): void {
  const recoveryNames: string[] = ["journal"];
  const probeDestinations: string[] = [];
  for (const probe of manifest.probes) {
    const match = /^probe-([a-f0-9-]{16,64})$/.exec(probe.origin);
    if (match?.[1] === undefined || probe.destination !== `.kompjutr-probe-${match[1]}`) {
      throw localError("ECORRUPT", "recovery probe names do not match");
    }
    recoveryNames.push(probe.origin);
    probeDestinations.push(`${probe.parent}/${probe.destination}`);
  }
  const touchPaths: string[] = [];
  for (const touch of manifest.touches) {
    if (touch.path === "/")
      throw localError("ECORRUPT", "recovery intent targets the workspace root");
    touchPaths.push(touch.path);
    if (touch.backup !== null) {
      if (!/^backup-[0-9]+$/.test(touch.backup)) {
        throw localError("ECORRUPT", "recovery backup name is invalid");
      }
      recoveryNames.push(touch.backup);
    }
  }
  const temporaryPaths: string[] = [];
  for (const temporary of manifest.temporaries) {
    const prefix = `.kompjutr-tmp-${manifest.initial.transaction}-`;
    if (
      !temporary.name.startsWith(prefix) ||
      !/^[0-9]+$/.test(temporary.name.slice(prefix.length))
    ) {
      throw localError("ECORRUPT", "recovery temporary name is invalid");
    }
    temporaryPaths.push(`${temporary.parent}/${temporary.name}`);
  }
  requireUnique(recoveryNames, "recovery directory names");
  requireUnique(probeDestinations, "recovery probe destinations");
  requireUnique(touchPaths, "recovery touch paths");
  requireUnique(temporaryPaths, "recovery temporary paths");
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function field(record: object, name: string): unknown {
  return Reflect.get(record, name);
}

function requireObject(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw localError("ECORRUPT", `${label} is not an object`);
  }
  return value;
}

function requireSequence(record: object, expected: number): number {
  const sequence = field(record, "sequence");
  if (!safeInteger(sequence) || sequence !== expected) {
    throw localError("ECORRUPT", "recovery journal sequence is invalid");
  }
  return sequence;
}

function requireName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("/") ||
    value.includes("\0") ||
    !value.isWellFormed()
  ) {
    throw localError("ECORRUPT", `${label} is invalid`);
  }
  return value;
}

function requirePath(value: unknown, label: string): string {
  if (value === "/") return value;
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    !value.startsWith("/") ||
    (value !== "/" && value.endsWith("/")) ||
    value
      .split("/")
      .some((part, index) => index > 0 && (part === "" || part === "." || part === ".."))
  ) {
    throw localError("ECORRUPT", `${label} is invalid`);
  }
  return value;
}

function decodeInitial(record: object, sequence: number): InitialRecord {
  const version = field(record, "version");
  const transaction = field(record, "transaction");
  const baseGeneration = field(record, "baseGeneration");
  const targetGeneration = field(record, "targetGeneration");
  if (
    sequence !== 0 ||
    version !== 1 ||
    typeof transaction !== "string" ||
    !/^[a-f0-9-]{16,64}$/.test(transaction) ||
    !safeInteger(baseGeneration) ||
    !safeInteger(targetGeneration) ||
    targetGeneration !== baseGeneration + 1
  ) {
    throw localError("ECORRUPT", "recovery journal initial record is invalid");
  }
  return { kind: "initial", sequence: 0, version, transaction, baseGeneration, targetGeneration };
}

function decodeProbe(record: object, sequence: number): ProbeRecord {
  return {
    kind: "probe",
    sequence,
    parent: requirePath(field(record, "parent"), "probe parent"),
    origin: requireName(field(record, "origin"), "probe origin"),
    destination: requireName(field(record, "destination"), "probe destination"),
  };
}

function decodeTouches(value: unknown): readonly TouchRecord[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_JOURNAL_RECORDS) {
    throw localError("ECORRUPT", "application touch list is invalid");
  }
  return value.map((raw) => {
    const touch = requireObject(raw, "application touch");
    const backup = field(touch, "backup");
    return {
      path: requirePath(field(touch, "path"), "application path"),
      backup: backup === null ? null : requireName(backup, "application backup"),
    };
  });
}

function decodeRecord(value: unknown, expected: number): JournalRecord {
  const record = requireObject(value, "recovery journal record");
  const sequence = requireSequence(record, expected);
  const kind = field(record, "kind");
  if (kind === "initial") return decodeInitial(record, sequence);
  if (kind === "probe") return decodeProbe(record, sequence);
  if (kind === "application") {
    return { kind, sequence, touches: decodeTouches(field(record, "touches")) };
  }
  if (kind === "temporary") {
    return {
      kind,
      sequence,
      parent: requirePath(field(record, "parent"), "temporary parent"),
      name: requireName(field(record, "name"), "temporary name"),
    };
  }
  throw localError("ECORRUPT", "recovery journal record kind is invalid");
}

function readExactly(fd: number, bytes: Uint8Array, position: number): boolean {
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(fd, bytes, offset, bytes.length - offset, position + offset);
    if (read === 0) return false;
    offset += read;
  }
  return true;
}

function encodeFrame(record: JournalRecord, maxFrameBytes = MAX_FRAME_BYTES): Uint8Array {
  const payload = encoder.encode(JSON.stringify(record));
  if (payload.length > maxFrameBytes)
    throw localError("E2BIG", "recovery journal frame is too large");
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length + CHECKSUM_BYTES);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, FRAME_HEADER_BYTES);
  frame.set(createHash("sha256").update(payload).digest(), FRAME_HEADER_BYTES + payload.length);
  return frame;
}

export class JournalWriter {
  readonly #fd: number;
  readonly #maxRecords: number;
  readonly #maxActions: number;
  readonly #maxFrameBytes: number;
  #sequence = 0;
  #actions = 0;
  #closed = false;

  constructor(
    path: string,
    maxRecords = MAX_JOURNAL_RECORDS,
    maxActions = MAX_RECOVERY_ACTIONS,
    maxFrameBytes = MAX_FRAME_BYTES,
  ) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_JOURNAL_RECORDS) {
      throw localError("EINVAL", "recovery journal record limit is invalid");
    }
    if (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > MAX_RECOVERY_ACTIONS) {
      throw localError("EINVAL", "recovery journal action limit is invalid");
    }
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 1 ||
      maxFrameBytes > MAX_FRAME_BYTES
    ) {
      throw localError("EINVAL", "recovery journal frame limit is invalid");
    }
    this.#maxRecords = maxRecords;
    this.#maxActions = maxActions;
    this.#maxFrameBytes = maxFrameBytes;
    try {
      this.#fd = openSync(path, "wx", 0o600);
    } catch (error) {
      normalizeHostError(error, "create recovery journal", path);
    }
  }

  append(record: AppendRecord): void {
    if (this.#sequence >= this.#maxRecords) {
      throw localError("E2BIG", "recovery journal has too many records");
    }
    const framed = { ...record, sequence: this.#sequence };
    const decoded = decodeRecord(framed, this.#sequence);
    const actions =
      decoded.kind === "initial" ? 0 : decoded.kind === "application" ? decoded.touches.length : 1;
    if (actions > this.#maxActions - this.#actions) {
      throw localError("E2BIG", "recovery journal has too many actions");
    }
    const frame = encodeFrame(decoded, this.#maxFrameBytes);
    let offset = 0;
    while (offset < frame.length) {
      const written = writeSync(this.#fd, frame, offset, frame.length - offset);
      if (written === 0) throw localError("EIO", "recovery journal write made no progress");
      offset += written;
    }
    fsyncSync(this.#fd);
    this.#sequence++;
    this.#actions += actions;
  }

  appendApplication(touches: readonly TouchRecord[], afterFrame?: () => void): void {
    if (touches.length === 0) throw localError("EINVAL", "application intent is empty");
    if (touches.length > this.#maxActions - this.#actions) {
      throw localError("E2BIG", "recovery journal has too many actions");
    }
    const chunks: TouchRecord[][] = [];
    let chunk: TouchRecord[] = [];
    let payloadBytes = 0;
    for (const touch of touches) {
      const touchBytes = encoder.encode(JSON.stringify(touch)).length;
      const sequence = this.#sequence + chunks.length;
      const emptyFrameBytes = encoder.encode(
        JSON.stringify({ kind: "application", touches: [], sequence }),
      ).length;
      const candidateBytes =
        emptyFrameBytes - 2 + payloadBytes + (chunk.length === 0 ? 0 : 1) + touchBytes;
      if (candidateBytes <= this.#maxFrameBytes) {
        chunk.push(touch);
        payloadBytes += (chunk.length === 1 ? 0 : 1) + touchBytes;
        continue;
      }
      if (chunk.length === 0) throw localError("E2BIG", "recovery journal frame is too large");
      chunks.push(chunk);
      chunk = [touch];
      payloadBytes = touchBytes;
      const nextSequence = this.#sequence + chunks.length;
      const singleFrameBytes =
        encoder.encode(JSON.stringify({ kind: "application", touches: [], sequence: nextSequence }))
          .length -
        2 +
        payloadBytes;
      if (singleFrameBytes > this.#maxFrameBytes) {
        throw localError("E2BIG", "recovery journal frame is too large");
      }
    }
    chunks.push(chunk);
    if (chunks.length > this.#maxRecords - this.#sequence) {
      throw localError("E2BIG", "recovery journal has too many records");
    }
    for (const applicationTouches of chunks) {
      this.append({ kind: "application", touches: applicationTouches });
      afterFrame?.();
    }
  }

  close(): void {
    if (this.#closed) return;
    closeSync(this.#fd);
    this.#closed = true;
  }
}

export function readJournal(
  path: string,
  maxRecords = MAX_JOURNAL_RECORDS,
  maxActions = MAX_RECOVERY_ACTIONS,
): RecoveryManifest | null {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_JOURNAL_RECORDS) {
    throw localError("EINVAL", "recovery journal record limit is invalid");
  }
  if (!Number.isSafeInteger(maxActions) || maxActions < 1 || maxActions > MAX_RECOVERY_ACTIONS) {
    throw localError("EINVAL", "recovery journal action limit is invalid");
  }
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    normalizeHostError(error, "open recovery journal", path);
  }
  const records: JournalRecord[] = [];
  let actions = 0;
  try {
    const size = fstatSync(fd).size;
    let position = 0;
    while (position < size) {
      if (records.length >= maxRecords)
        throw localError("ECORRUPT", "recovery journal has too many records");
      const header = new Uint8Array(FRAME_HEADER_BYTES);
      if (!readExactly(fd, header, position)) break;
      position += FRAME_HEADER_BYTES;
      const length = new DataView(header.buffer).getUint32(0, false);
      if (length > MAX_FRAME_BYTES)
        throw localError("ECORRUPT", "recovery journal frame is too large");
      if (size - position < length + CHECKSUM_BYTES) break;
      const payload = new Uint8Array(length);
      const checksum = new Uint8Array(CHECKSUM_BYTES);
      if (!readExactly(fd, payload, position)) break;
      position += length;
      if (!readExactly(fd, checksum, position)) break;
      position += CHECKSUM_BYTES;
      const expected = createHash("sha256").update(payload).digest();
      if (!timingSafeEqual(checksum, expected)) {
        throw localError("ECORRUPT", "recovery journal frame checksum is invalid");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoder.decode(payload));
      } catch {
        throw localError("ECORRUPT", "recovery journal frame payload is invalid");
      }
      const record = decodeRecord(parsed, records.length);
      const added =
        record.kind === "initial" ? 0 : record.kind === "application" ? record.touches.length : 1;
      if (added > maxActions - actions) {
        throw localError("ECORRUPT", "recovery journal has too many actions");
      }
      records.push(record);
      actions += added;
    }
  } finally {
    closeSync(fd);
  }

  const initial = records[0];
  if (initial === undefined) return null;
  if (initial?.kind !== "initial")
    throw localError("ECORRUPT", "recovery journal has no initial record");
  const probes: ProbeRecord[] = [];
  const touches: TouchRecord[] = [];
  const temporaries: TemporaryRecord[] = [];
  for (const record of records.slice(1)) {
    if (record.kind === "initial")
      throw localError("ECORRUPT", "recovery journal repeats its initial record");
    if (record.kind === "probe") probes.push(record);
    else if (record.kind === "application") touches.push(...record.touches);
    else temporaries.push(record);
  }
  const manifest = { initial, probes, touches, temporaries };
  validateRecoveryManifest(manifest);
  return manifest;
}
