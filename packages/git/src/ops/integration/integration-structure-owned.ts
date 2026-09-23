import { CorruptError, GitError } from "../../common/errors.js";
import { isNestedPath } from "../../common/paths.js";
import { joinSorted3 } from "../../common/streams.js";
import type { StructuralIntegrationEntry } from "../../store/operations/integration-workspace/descriptors.js";
import type { IntegrationPlanHandle } from "../../store/operations/integration-workspace/storage.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";
import { classifyRow, validated } from "./integration-structure.js";
import type { IntegrationStages, ResolvedLimits } from "./integration-structure-types.js";
import type { IntegrationInput } from "./integration-types.js";

interface Prefix {
  path: string;
  stages: IntegrationStages;
  entry: StructuralIntegrationEntry | null;
}

export function classifyIntegrationStructureOwned(
  workspace: IntegrationWorkspace,
  input: IntegrationInput,
  limits: ResolvedLimits,
): IntegrationPlanHandle<StructuralIntegrationEntry> {
  const plan = workspace.structuralPlan();
  if (
    input.currentTreeOid === input.incomingTreeOid ||
    input.baseTreeOid === input.incomingTreeOid
  ) {
    const roots = new Set<string>();
    for (const oid of [input.baseTreeOid, input.currentTreeOid, input.incomingTreeOid]) {
      if (oid !== null) roots.add(oid);
    }
    for (const info of workspace.source.objectInfo([...roots])) {
      if (info.type !== "tree") throw new CorruptError(`${info.oid} is a ${info.type}, not a tree`);
      const cursor = workspace.source.walkTree(info.oid);
      try {
        cursor.next();
      } finally {
        cursor.return(undefined);
      }
    }
    plan.finish(0, 0);
    return plan;
  }
  const stream = (oid: string | null) => (oid === null ? [] : workspace.source.walkTree(oid));
  let sourceRows = 0;
  let entryCount = 0;
  function* classify(): Generator<StructuralIntegrationEntry> {
    // Each valid input tree is an antichain of leaf paths, so at most three
    // active prefix candidates can exist across the three input streams.
    const prefixes: Prefix[] = [];
    for (const row of joinSorted3(
      validated(stream(input.baseTreeOid), "base"),
      validated(stream(input.currentTreeOid), "current"),
      validated(stream(input.incomingTreeOid), "incoming"),
      { a: (entry) => entry.path, b: (entry) => entry.path, c: (entry) => entry.path },
    )) {
      if (sourceRows >= limits.maxRows)
        throw new GitError("E2BIG", `integration structure exceeds ${limits.maxRows} source rows`);
      sourceRows++;
      while (prefixes.length > 0 && !isNestedPath(prefixes[prefixes.length - 1]!.path, row.path)) {
        prefixes.pop();
      }
      const stages: IntegrationStages = {
        base: row.a ?? null,
        current: row.b ?? null,
        incoming: row.c ?? null,
      };
      const classified = classifyRow(row.path, row.a, row.b, row.c);
      let entry = classified.entry;
      if (classified.occupiesPath && prefixes.length > 0) {
        for (const prefix of prefixes) {
          const replacement: StructuralIntegrationEntry = {
            kind: "conflict",
            path: prefix.path,
            conflict: "file/directory",
            stages: prefix.stages,
          };
          if (prefix.entry === null) entryCount++;
          prefix.entry = replacement;
          yield replacement;
        }
        entry = { kind: "conflict", path: row.path, conflict: "file/directory", stages };
      }
      if (entry !== null) {
        entryCount++;
        yield entry;
      }
      if (
        classified.occupiesPath &&
        (row.a === undefined || row.b === undefined || row.c === undefined)
      ) {
        prefixes.push({ path: row.path, stages, entry });
      }
    }
  }
  plan.entries.write(classify());
  plan.finish(sourceRows, entryCount);
  return plan;
}
