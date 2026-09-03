import { type ByteStream, withUnusedRestorer } from "./bytes.js";
import { type BoundedFs, ShellLimitError } from "./context.js";
import { addUtf8Bytes, utf8Bytes } from "./utf8.js";

const ENV_ENTRY_MAX = 256;
const ENCODER = new TextEncoder();

/** Own caller inputs and their retained-memory reservation for one complete run. */
export class RunInputOwner {
  #closed = false;
  #offset = 0;

  constructor(
    private readonly source: Uint8Array | null,
    readonly env: Readonly<Record<string, string>> | undefined,
    private readonly release: () => void,
  ) {}

  /** A pipeline may close its borrow without closing the run-owned cursor. */
  borrow(): ByteStream | null {
    const source = this.source;
    if (source === null) return null;
    const start = this.#offset;
    const owner = this;
    const stream = (function* (): ByteStream {
      if (start >= source.length) return;
      owner.#offset = source.length;
      yield source.subarray(start);
    })();
    let restored = false;
    return withUnusedRestorer(stream, (unused) => {
      if (restored) return;
      restored = true;
      const suffixStart = source.length - unused.length;
      if (
        suffixStart < start ||
        unused.buffer !== source.buffer ||
        unused.byteOffset !== source.byteOffset + suffixStart
      ) {
        throw new Error("caller stdin restorer received a non-suffix view");
      }
      owner.#offset = suffixStart;
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.release();
  }
}

export function prepareRunInput(
  stdin: Uint8Array | string | undefined,
  env: Readonly<Record<string, string>> | undefined,
  fs: BoundedFs,
): RunInputOwner | null {
  if (stdin === undefined && env === undefined) return null;
  const stdinSize = stdin === undefined ? 0 : stdinBytes(stdin);
  const environment = measureEnvironment(env);
  const release = fs.retained.retain(stdinSize + environment.bytes, "caller inputs");
  try {
    const stdinSnapshot =
      stdin === undefined
        ? null
        : typeof stdin === "string"
          ? ENCODER.encode(stdin)
          : stdin.slice();
    const envSnapshot = snapshotEnvironment(env, environment);
    return new RunInputOwner(stdinSnapshot, envSnapshot, release);
  } catch (error) {
    release();
    throw error;
  }
}

interface EnvironmentMeasurement {
  readonly entries: number;
  readonly bytes: number;
}

function measureEnvironment(
  env: Readonly<Record<string, string>> | undefined,
): EnvironmentMeasurement {
  if (env === undefined) return { entries: 0, bytes: 0 };
  if (typeof env !== "object" || env === null) {
    throw new ShellLimitError("arguments", "caller env must be an object with string values");
  }

  let entries = 0;
  let bytes = 0;
  for (const key in env) {
    if (!Object.hasOwn(env, key)) continue;
    entries++;
    if (entries > ENV_ENTRY_MAX) {
      throw new ShellLimitError("arguments", `caller env exceeds ${ENV_ENTRY_MAX} entries`);
    }
    const value = env[key];
    if (typeof value !== "string") {
      throw new ShellLimitError("arguments", "caller env values must be strings");
    }
    bytes = addUtf8Bytes(bytes, key, "caller env");
    bytes = addUtf8Bytes(bytes, value, "caller env");
  }
  return { entries, bytes };
}

function snapshotEnvironment(
  env: Readonly<Record<string, string>> | undefined,
  measured: EnvironmentMeasurement,
): Readonly<Record<string, string>> | undefined {
  if (env === undefined) return undefined;
  const entries: Array<readonly [string, string]> = [];
  let bytes = 0;
  for (const key in env) {
    if (!Object.hasOwn(env, key)) continue;
    if (entries.length >= measured.entries) {
      throw new ShellLimitError("arguments", "caller env changed while it was snapshotted");
    }
    const value = env[key];
    if (typeof value !== "string") {
      throw new ShellLimitError("arguments", "caller env values must be strings");
    }
    bytes = addUtf8Bytes(bytes, key, "caller env snapshot");
    bytes = addUtf8Bytes(bytes, value, "caller env snapshot");
    if (bytes > measured.bytes) {
      throw new ShellLimitError("arguments", "caller env changed while it was snapshotted");
    }
    entries.push([key, value]);
  }
  if (entries.length !== measured.entries || bytes !== measured.bytes) {
    throw new ShellLimitError("arguments", "caller env changed while it was snapshotted");
  }
  return Object.freeze(Object.fromEntries(entries));
}

function stdinBytes(stdin: Uint8Array | string): number {
  if (typeof stdin !== "string") {
    if (!(stdin instanceof Uint8Array)) {
      throw new ShellLimitError("arguments", "caller stdin must be a string or Uint8Array");
    }
    return stdin.byteLength;
  }

  return utf8Bytes(stdin);
}
