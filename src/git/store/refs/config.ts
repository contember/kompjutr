import type { SqlDatabase } from "../../../db/db.js";
import { CorruptError, GitError, hasErrorCode } from "../../common/errors.js";
import { checkRefText } from "../../common/ref-name.js";
import { expectText, int, RowShape, text } from "../../common/rows.js";
import type { BoundedSingleConfigValue, ConfigValueCardinality } from "../core/contracts.js";
import { jsonPages, utf8ByteLength } from "../core/json-pages.js";
import { MAX_INDEX_PATH_BYTES } from "../schema/schema.js";

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
    return this.getBounded(requireConfigPath(path));
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
    const checkedPath = requireConfigPath(path, "bounded config path");
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new GitError("EINVAL", "config byte limit must be a non-negative safe integer");
    }

    const rows = this.db.all<{ value: unknown }>(
      `SELECT value FROM git_config
        WHERE repo_id = ? AND path = ? ORDER BY seq LIMIT 2`,
      this.repoId,
      checkedPath,
    );
    if (rows.length === 0) return { kind: "missing" };
    if (rows.length !== 1) return { kind: "multiple" };
    const value = expectText(rows[0]?.value, `config ${checkedPath}`);
    if (maxBytes !== undefined && utf8ByteLength(value) > maxBytes) {
      throw new GitError("E2BIG", `config ${path} exceeds ${maxBytes} bytes`);
    }
    return { kind: "single", value };
  }

  /** Inspect zero, one, or multiple values without materialising their payloads. */
  cardinality(path: string): ConfigValueCardinality {
    const checkedPath = requireConfigPath(path);
    const rows = this.db.all<{ value: unknown }>(
      `SELECT value FROM git_config
        WHERE repo_id = ? AND path = ? ORDER BY seq LIMIT 2`,
      this.repoId,
      checkedPath,
    ).length;
    return rows === 0 ? "missing" : rows === 1 ? "single" : "multiple";
  }

  set(path: string, value: string): void {
    const checkedPath = requireConfigPath(path);
    this.db.transactionSync(() => {
      this.db.run(
        "DELETE FROM git_config WHERE repo_id = ? AND path = ?",
        this.repoId,
        checkedPath,
      );
      this.db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, 0, ?)",
        this.repoId,
        checkedPath,
        value,
      );
    });
  }

  add(path: string, value: string): void {
    const checkedPath = requireConfigPath(path);
    this.db.transactionSync(() => {
      const seq =
        (this.db.scalar<number | null>(
          "SELECT MAX(seq) FROM git_config WHERE repo_id = ? AND path = ?",
          this.repoId,
          checkedPath,
        ) ?? -1) + 1;
      this.db.run(
        "INSERT INTO git_config (repo_id, path, seq, value) VALUES (?, ?, ?, ?)",
        this.repoId,
        checkedPath,
        seq,
        value,
      );
    });
  }

  unset(path: string): void {
    const checkedPath = requireConfigPath(path);
    this.db.run("DELETE FROM git_config WHERE repo_id = ? AND path = ?", this.repoId, checkedPath);
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
    const [source, destination] = requireConfigSectionMove(sourcePrefix, destinationPrefix);

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

export function requireConfigPath(value: unknown, label = "config path"): string {
  if (typeof value !== "string" || value === "") {
    throw new GitError("EINVAL", `${label} must be a non-empty string`);
  }
  boundedCanonicalUtf8Bytes(value, MAX_INDEX_PATH_BYTES, label);
  return value;
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

export function requireConfigSectionMove(
  sourcePrefix: string,
  destinationPrefix: string,
): readonly [source: string, destination: string] {
  const source = requireConfigSectionPrefix(sourcePrefix, "source");
  const destination = requireConfigSectionPrefix(destinationPrefix, "destination");
  if (source === destination) {
    throw new GitError("EINVAL", "config section source and destination must differ");
  }
  return [source, destination];
}

export function boundedCanonicalUtf8Bytes(value: string, limit: number, label: string): number {
  const checked = checkRefText(value, limit);
  if (checked.problem === "invalid-character") {
    throw new GitError("EINVAL", `${label} contains an invalid character`);
  }
  if (checked.problem === "noncanonical-utf16") {
    throw new GitError("EINVAL", `${label} is not canonical UTF-16`);
  }
  if (checked.problem === "too-long") {
    throw new GitError("E2BIG", `${label} exceeds ${limit} UTF-8 bytes`);
  }
  return checked.bytes;
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
