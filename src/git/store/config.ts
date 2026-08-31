import type { SqlDatabase } from "../../db/db.js";
import { CorruptError, GitError, hasErrorCode } from "../common/errors.js";
import { expectText, int, RowShape, text } from "../common/rows.js";
import type { BoundedSingleConfigValue, ConfigValueCardinality } from "./contracts.js";
import { jsonPages, utf8ByteLength } from "./json-pages.js";
import { MAX_INDEX_PATH_BYTES } from "./schema.js";

export const MAX_CONFIG_SECTION_MOVE_ROWS = 1_024;
export const CONFIG_SECTION_MOVE_UPDATE_SQL = `UPDATE git_config
       SET path = ? || substr(path, length(?) + 1)
     WHERE repo_id = ? AND path >= ? AND path < ?
       AND EXISTS (
         SELECT 1 FROM json_each(?) AS wanted
          WHERE json_extract(wanted.value, '$.path') = git_config.path
            AND json_extract(wanted.value, '$.seq') = git_config.seq
       )`;

export interface ConfigSectionCandidateMetadata {
  readonly path: string;
  readonly seq: number;
}

export interface ConfigTableOwner {
  configGetOwned(path: string): string | undefined;
}

const CONFIG_SECTION_ROW = new RowShape({ path: text(), seq: int(0) });

/** Internal last-value config read through the shared repository seam. */
export function configGetOwned(store: ConfigTableOwner, path: string): string | undefined {
  return store.configGetOwned(path);
}

export class ConfigTable {
  constructor(
    private readonly db: SqlDatabase,
    private readonly repoId: number,
  ) {}

  getAll(path: string): string[] {
    return this.db
      .all<{ value: unknown }>(
        "SELECT value FROM git_config WHERE repo_id = ? AND path = ? ORDER BY seq",
        this.repoId,
        path,
      )
      .map((row) => expectText(row.value, `config ${path}`));
  }

  get(path: string): string | undefined {
    // git's `--get` reports the last value for a multi-valued key.
    const values = this.getAll(path);
    return values.length === 0 ? undefined : values[values.length - 1];
  }

  getOwned(path: string): string | undefined {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "config path must be a non-empty string");
    }
    return this.getBounded(path);
  }

  /** Read one config value with an optional payload limit. */
  getBounded(path: string, maxBytes?: number): string | undefined {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new GitError("EINVAL", "config byte limit must be a non-negative safe integer");
    }
    const row = this.db.one<{ value: unknown }>(
      `SELECT value FROM git_config
        WHERE repo_id = ? AND path = ? ORDER BY seq DESC LIMIT 1`,
      this.repoId,
      path,
    );
    if (row === undefined) return undefined;
    const value = expectText(row.value, `config ${path}`);
    if (maxBytes !== undefined && utf8ByteLength(value) > maxBytes) {
      throw new GitError("E2BIG", `config ${path} exceeds ${maxBytes} bytes`);
    }
    return value;
  }

  /** Read zero or one value without materialising an unbounded multi-valued key. */
  getSingleBounded(path: string, maxBytes?: number): BoundedSingleConfigValue {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "bounded config path must be a non-empty string");
    }
    boundedCanonicalUtf8Bytes(path, MAX_INDEX_PATH_BYTES, "bounded config path");
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new GitError("EINVAL", "config byte limit must be a non-negative safe integer");
    }

    const rows = this.db.all<{ value: unknown }>(
      `SELECT value FROM git_config
        WHERE repo_id = ? AND path = ? ORDER BY seq LIMIT 2`,
      this.repoId,
      path,
    );
    if (rows.length === 0) return { kind: "missing" };
    if (rows.length !== 1) return { kind: "multiple" };
    const value = expectText(rows[0]?.value, `config ${path}`);
    if (maxBytes !== undefined && utf8ByteLength(value) > maxBytes) {
      throw new GitError("E2BIG", `config ${path} exceeds ${maxBytes} bytes`);
    }
    return { kind: "single", value };
  }

  /** Inspect zero, one, or multiple values without materialising their payloads. */
  cardinality(path: string): ConfigValueCardinality {
    if (typeof path !== "string" || path === "") {
      throw new GitError("EINVAL", "config path must be a non-empty string");
    }
    boundedCanonicalUtf8Bytes(path, MAX_INDEX_PATH_BYTES, "config path");
    const rows = this.db.all<{ value: unknown }>(
      `SELECT value FROM git_config
        WHERE repo_id = ? AND path = ? ORDER BY seq LIMIT 2`,
      this.repoId,
      path,
    ).length;
    return rows === 0 ? "missing" : rows === 1 ? "single" : "multiple";
  }

  set(path: string, value: string): void {
    this.db.transactionSync(() => {
      this.db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.repoId, path);
      this.db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, 0, ?)",
        this.repoId,
        path,
        value,
      );
    });
  }

  add(path: string, value: string): void {
    this.db.transactionSync(() => {
      const seq =
        (this.db.scalar<number | null>(
          "SELECT MAX(seq) FROM git_config WHERE repo_id = ? AND path = ?",
          this.repoId,
          path,
        ) ?? -1) + 1;
      this.db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, ?, ?)",
        this.repoId,
        path,
        seq,
        value,
      );
    });
  }

  unset(path: string): void {
    this.db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.repoId, path);
  }

  /** Distinct config paths under a dotted prefix, e.g. "remote.". */
  paths(prefix: string): string[] {
    return this.db
      .all<{ path: unknown }>(
        "SELECT DISTINCT path FROM git_config WHERE repo_id = ? AND path >= ? AND path < ? ORDER BY path",
        this.repoId,
        prefix,
        nextPrefix(prefix),
      )
      .map((row) => expectText(row.path, "stored config path"));
  }

  /** Validate and move one exact dotted config section without changing value order. */
  moveSection(sourcePrefix: string, destinationPrefix: string): void {
    const source = requireConfigSectionPrefix(sourcePrefix, "source");
    const destination = requireConfigSectionPrefix(destinationPrefix, "destination");
    if (source === destination) {
      throw new GitError("EINVAL", "config section source and destination must differ");
    }

    this.db.transactionSync(() => {
      let destinationCandidates = 0;
      for (const row of this.db.iterate(
        configSectionMetadataSql(),
        this.repoId,
        destination,
        nextPrefix(destination),
      )) {
        destinationCandidates++;
        if (destinationCandidates > MAX_CONFIG_SECTION_MOVE_ROWS) {
          throw new GitError(
            "E2BIG",
            `config section ${destination} exceeds ${MAX_CONFIG_SECTION_MOVE_ROWS} inspected rows`,
          );
        }
        const candidate = requireConfigSectionMetadata(row);
        if (configSectionVariable(candidate.path, destination) !== null) {
          throw new GitError("EEXIST", `config section ${destination} already exists`);
        }
      }

      const metadata: ConfigSectionCandidateMetadata[] = [];
      let sourceCandidates = 0;
      for (const row of this.db.iterate(
        configSectionMetadataSql(),
        this.repoId,
        source,
        nextPrefix(source),
      )) {
        sourceCandidates++;
        if (sourceCandidates > MAX_CONFIG_SECTION_MOVE_ROWS) {
          throw new GitError(
            "E2BIG",
            `config section ${source} exceeds ${MAX_CONFIG_SECTION_MOVE_ROWS} inspected rows`,
          );
        }
        const candidate = requireConfigSectionMetadata(row);
        const variable = configSectionVariable(candidate.path, source);
        if (variable === null) continue;
        configSectionDestinationBytes(destination, variable);
        metadata.push(candidate);
      }
      if (metadata.length === 0) return;

      function* updateRows(): Generator<{ path: string; seq: number }> {
        for (const row of metadata) yield { path: row.path, seq: row.seq };
      }
      let changedRows = 0;
      for (const page of jsonPages(updateRows(), "config section move")) {
        this.db.run(
          CONFIG_SECTION_MOVE_UPDATE_SQL,
          destination,
          source,
          this.repoId,
          source,
          nextPrefix(source),
          page,
        );
        const changed = this.db.scalar<unknown>("SELECT changes()");
        if (typeof changed !== "number" || !Number.isSafeInteger(changed) || changed < 0) {
          throw new CorruptError(`config section ${source} returned an invalid change count`);
        }
        changedRows += changed;
      }
      if (changedRows !== metadata.length) {
        throw new CorruptError(`config section ${source} changed during its move`);
      }
    });
  }
}

/** The exclusive upper bound of a string prefix range. */
export function nextPrefix(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

export function requireConfigSectionPrefix(value: string, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new GitError("EINVAL", `config section ${label} is required`);
  }
  boundedCanonicalUtf8Bytes(value, MAX_INDEX_PATH_BYTES, `config section ${label}`);
  if (value === "." || value.startsWith(".") || !value.endsWith(".") || value.includes("..")) {
    throw new GitError("EINVAL", `config section ${label} is not a canonical dotted prefix`);
  }
  return value;
}

export function boundedCanonicalUtf8Bytes(value: string, limit: number, label: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      throw new GitError("EINVAL", `${label} contains an invalid character`);
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new GitError("EINVAL", `${label} is not canonical UTF-16`);
      }
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new GitError("EINVAL", `${label} is not canonical UTF-16`);
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", `${label} is not canonical UTF-16`);
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > limit) throw new GitError("E2BIG", `${label} exceeds ${limit} UTF-8 bytes`);
  }
  return bytes;
}

export function configSectionMetadataSql(): string {
  return `SELECT path, seq FROM git_config
          WHERE repo_id = ? AND path >= ? AND path < ?
          ORDER BY path COLLATE BINARY, seq
          LIMIT ${MAX_CONFIG_SECTION_MOVE_ROWS + 1}`;
}

export function requireConfigSectionMetadata(row: unknown): ConfigSectionCandidateMetadata {
  return CONFIG_SECTION_ROW.decode(row);
}

export function configSectionVariable(path: string, prefix: string): string | null {
  const variable = path.slice(prefix.length);
  if (variable === "") {
    throw new CorruptError(`config section ${prefix} has an empty variable name`);
  }
  return variable.includes(".") ? null : variable;
}

export function configSectionDestinationBytes(destination: string, variable: string): number {
  const destinationBytes = boundedCanonicalUtf8Bytes(
    destination,
    MAX_INDEX_PATH_BYTES,
    "config section destination",
  );
  const remaining = MAX_INDEX_PATH_BYTES - destinationBytes;
  let variableBytes: number;
  try {
    variableBytes = boundedCanonicalUtf8Bytes(variable, remaining, "moved config variable");
  } catch (error) {
    if (hasErrorCode(error, "E2BIG")) throw error;
    throw new CorruptError("config section has an invalid stored variable name", { cause: error });
  }
  return destinationBytes + variableBytes;
}
