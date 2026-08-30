import { MemoryCoordinator, type MemoryReservation } from "../memory.js";
import type { SqlDatabase } from "../sqlite/db.js";
import { filesystemError } from "./errors.js";

export type ExactPathState = "present" | "missing";

/** Optional bulk capability for consumers that already hold canonical real paths. */
export interface ExactPathStateSource {
  states(paths: readonly string[]): readonly ExactPathState[];
}

type OwnedExactPathStates = (
  paths: readonly string[],
  reservation: MemoryReservation,
) => readonly ExactPathState[];

const OWNED_EXACT_PATH_STATES = new WeakMap<ExactPathStateSource, OwnedExactPathStates>();

const MAX_PATHS = 1_024;
const MAX_JSON_BYTES = 1_500_000;
const ARRAY_FIXED_BYTES = 64;
const ARRAY_SLOT_BYTES = 8;
const STRING_FIXED_BYTES = 48;
const SQL_ROW_FIXED_BYTES = 512;

const STATES_SQL = `
WITH requested AS (
  SELECT CAST(key AS INTEGER) AS ordinal, value AS path
    FROM json_each(?)
)
SELECT requested.ordinal AS ordinal,
       requested.path AS path,
       stored.path AS stored_path,
       stored.inode AS path_inode,
       node.inode AS node_inode,
       typeof(node.type) AS node_type_storage,
       length(CAST(node.type AS BLOB)) AS node_type_bytes,
       CASE
         WHEN node.type = 'file' THEN 'file'
         WHEN node.type = 'dir' THEN 'dir'
         WHEN node.type = 'symlink' THEN 'symlink'
         WHEN node.type IS NULL THEN NULL
         ELSE 'invalid'
       END AS node_type
  FROM requested
  LEFT JOIN fs_paths stored ON stored.path = requested.path
  LEFT JOIN fs_nodes node ON node.inode = stored.inode
 ORDER BY requested.ordinal`;

function retainedStringUnits(units: number): number {
  return STRING_FIXED_BYTES + units * 2;
}

function jsonStringSize(value: string): { bytes: number; units: number } {
  let bytes = 2;
  let units = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
      units += 2;
    } else if (code < 0x20) {
      bytes += 6;
      units += 6;
    } else if (code < 0x80) {
      bytes++;
      units++;
    } else if (code < 0x800) {
      bytes += 2;
      units++;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        units += 2;
        index++;
      } else {
        bytes += 6;
        units += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
      units += 6;
    } else {
      bytes += 3;
      units++;
    }
  }
  return { bytes, units };
}

function isCanonical(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\0")) return false;
  if (path === "/") return true;
  if (path.endsWith("/")) return false;
  let segmentStart = 1;
  for (let index = 1; index <= path.length; index++) {
    if (index < path.length && path.charCodeAt(index) !== 0x2f) continue;
    const length = index - segmentStart;
    if (
      length === 0 ||
      (length === 1 && path.charCodeAt(segmentStart) === 0x2e) ||
      (length === 2 &&
        path.charCodeAt(segmentStart) === 0x2e &&
        path.charCodeAt(segmentStart + 1) === 0x2e)
    ) {
      return false;
    }
    segmentStart = index + 1;
  }
  return true;
}

function validatePath(path: unknown): string {
  if (typeof path !== "string") {
    throw filesystemError("EINVAL", "exact path must be a string");
  }
  if (!isCanonical(path)) {
    throw filesystemError("EINVAL", "exact path is not canonical", path);
  }
  return path;
}

function validateRow(
  row: Record<string, unknown>,
  paths: readonly string[],
  expectedOrdinal: number,
): ExactPathState {
  if (row.ordinal !== expectedOrdinal || row.path !== paths[expectedOrdinal]) {
    throw filesystemError("EIO", "exact path state query returned an invalid row order");
  }
  if (row.stored_path === null) {
    if (
      row.path_inode !== null ||
      row.node_inode !== null ||
      row.node_type_storage !== "null" ||
      row.node_type_bytes !== null ||
      row.node_type !== null
    ) {
      throw filesystemError("EIO", "missing exact path returned persisted node state");
    }
    return "missing";
  }
  if (row.stored_path !== row.path) {
    throw filesystemError("EIO", "exact path state query crossed path boundaries");
  }
  const expectedTypeBytes =
    row.node_type === "file"
      ? 4
      : row.node_type === "dir"
        ? 3
        : row.node_type === "symlink"
          ? 7
          : null;
  if (
    typeof row.path_inode !== "number" ||
    !Number.isSafeInteger(row.path_inode) ||
    row.path_inode < 1 ||
    row.node_inode !== row.path_inode ||
    row.node_type_storage !== "text" ||
    typeof row.node_type_bytes !== "number" ||
    !Number.isSafeInteger(row.node_type_bytes) ||
    expectedTypeBytes === null ||
    row.node_type_bytes !== expectedTypeBytes
  ) {
    throw filesystemError("EIO", "exact path state query returned an invalid node");
  }
  return "present";
}

function states(
  db: SqlDatabase,
  paths: readonly string[],
  reservation: MemoryReservation,
): readonly ExactPathState[] {
  if (paths.length > MAX_PATHS) {
    throw filesystemError("E2BIG", `exact path lookup accepts at most ${MAX_PATHS} paths`);
  }

  const validatedMemory = reservation.scope();
  const pageMemory = reservation.scope();
  const resultMemory = reservation.scope();
  validatedMemory.set("other", ARRAY_FIXED_BYTES + paths.length * ARRAY_SLOT_BYTES);
  const validated: string[] = [];
  pageMemory.set("other", 2 * ARRAY_FIXED_BYTES);
  const pagePaths: string[] = [];
  const pageItems: string[] = [];
  resultMemory.set("other", ARRAY_FIXED_BYTES + paths.length * ARRAY_SLOT_BYTES);
  const result: ExactPathState[] = [];
  let pageCapacity = 0;
  let pageItemStringBytes = 0;
  let pageBytes = 2;
  let pageMaximumPathUnits = 0;

  const flush = (): void => {
    if (pagePaths.length === 0) return;
    const joinedUnits =
      pageItems.reduce((units, item) => units + item.length, 0) + pageItems.length - 1;
    const bindingMemory = reservation.scope();
    const rowMemory = reservation.scope();
    bindingMemory.set(
      "other",
      retainedStringUnits(joinedUnits) + retainedStringUnits(joinedUnits + 2),
    );
    rowMemory.set("other", SQL_ROW_FIXED_BYTES + 2 * retainedStringUnits(pageMaximumPathUnits));
    let ordinal = 0;
    try {
      const joined = pageItems.join(",");
      const framed = `[${joined}]`;
      for (const row of db.iterate(STATES_SQL, framed)) {
        result.push(validateRow(row, pagePaths, ordinal));
        ordinal++;
      }
      if (ordinal !== pagePaths.length) {
        throw filesystemError("EIO", "exact path state query returned an incomplete page");
      }
    } finally {
      rowMemory.dispose();
      bindingMemory.dispose();
    }
    pagePaths.length = 0;
    pageItems.length = 0;
    pageItemStringBytes = 0;
    pageBytes = 2;
    pageMaximumPathUnits = 0;
    pageMemory.set("other", 2 * ARRAY_FIXED_BYTES + pageCapacity * 2 * ARRAY_SLOT_BYTES);
  };

  try {
    for (const path of paths) validated.push(validatePath(path));
    for (const path of validated) {
      const itemSize = jsonStringSize(path);
      const separatorBytes = pageItems.length === 0 ? 0 : 1;
      const nextBytes = pageBytes + separatorBytes + itemSize.bytes;
      if (pageItems.length > 0 && nextBytes > MAX_JSON_BYTES) flush();
      pageCapacity = Math.max(pageCapacity, pageItems.length + 1);
      pageMemory.set(
        "other",
        2 * ARRAY_FIXED_BYTES +
          pageCapacity * 2 * ARRAY_SLOT_BYTES +
          pageItemStringBytes +
          retainedStringUnits(itemSize.units),
      );
      const item = JSON.stringify(path);
      pagePaths.push(path);
      pageItems.push(item);
      pageItemStringBytes += retainedStringUnits(item.length);
      pageBytes += (pageItems.length === 1 ? 0 : 1) + itemSize.bytes;
      pageMaximumPathUnits = Math.max(pageMaximumPathUnits, path.length);
    }
    flush();

    if (result.length !== validated.length) {
      throw filesystemError("EIO", "exact path state query returned an invalid result length");
    }
    return Object.freeze(result);
  } finally {
    resultMemory.dispose();
    pageMemory.dispose();
    validatedMemory.dispose();
  }
}

export function createExactPathStateSource(
  db: SqlDatabase,
  memory = new MemoryCoordinator(),
): ExactPathStateSource {
  const source: ExactPathStateSource = {
    states: (paths) => {
      const reservation = memory.reserve();
      try {
        return states(db, paths, reservation);
      } finally {
        reservation.dispose();
      }
    },
  };
  OWNED_EXACT_PATH_STATES.set(source, (paths, owningReservation) => {
    const reservation = owningReservation.scope();
    try {
      return states(db, paths, reservation);
    } finally {
      reservation.dispose();
    }
  });
  return source;
}

/** Use a native source under the caller's operation owner without widening its public contract. */
export function exactPathStatesOwned(
  source: ExactPathStateSource,
  paths: readonly string[],
  reservation: MemoryReservation,
): readonly ExactPathState[] | null {
  return OWNED_EXACT_PATH_STATES.get(source)?.(paths, reservation) ?? null;
}
