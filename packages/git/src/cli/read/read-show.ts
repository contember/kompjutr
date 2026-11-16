import { isTreeMode } from "../../common/trees.js";
import type { Repository } from "../../ops/repository/repository.js";
import {
  type GitCliOutputContext,
  gitCliDiagnosticResult,
  gitCliStdoutPartsResult,
} from "../result.js";
import type { GitCliResult } from "../types.js";

// Keep a leading BOM: Git prints blob bytes unchanged.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * `git show` of a blob prints its content and of a tree its entry names, as
 * Git does. Returns undefined for a commit. Reads may throw
 * PromisedObjectError, so call it under promisor hydration.
 */
export function showNonCommit(
  repo: Repository,
  ref: string,
  maximum: number,
  output: GitCliOutputContext,
): GitCliResult | undefined {
  const oid = repo.peel(repo.revParse(ref));
  const type = repo.typeOf(oid);
  if (type === "tree") {
    const names = repo
      .readTree(oid)
      .map((entry) => (isTreeMode(entry.mode) ? `${entry.name}/\n` : `${entry.name}\n`));
    return gitCliStdoutPartsResult([`tree ${ref}\n\n`, ...names], maximum);
  }
  if (type !== "blob") return undefined;
  const bytes = repo.readBlob(oid);
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    // CLI stdout is a string; lossy decoding would corrupt a redirected binary file.
    return gitCliDiagnosticResult("fatal: ", ref, " is not UTF-8 text\n", 128, output);
  }
  return gitCliStdoutPartsResult([text], maximum);
}
