// Which file a patch is for.
//
// A file operand names it outright. A git patch names it in its header. For
// any other patch the candidates are the old name, the new name, and the
// `Index:` name when the header has neither: the best existing one wins; when
// none exists and the patch creates a file, the best one needing the fewest
// new directories; when it deletes one, the best named.

import { bestName, isDangerous, namesAbsentFile, stripName } from "./names.js";
import type { PatchOptions } from "./options.js";
import { quoteName, type Report } from "./report.js";
import type { PatchHeader } from "./scan.js";
import { lineText } from "./text.js";
import type { Lookup, Workspace } from "./workspace.js";

export interface Target {
  /** The name as messages show it. */
  readonly name: string;
  readonly lookup: Lookup;
  /** Checked for escaping the working directory before writing. */
  readonly checked: boolean;
}

export interface Resolved {
  readonly target: Target | null;
  /** Where the content comes from when a git patch renames or copies. */
  readonly source: Target | null;
  /** In the direction the patch is applied. */
  readonly creates: boolean;
  readonly deletes: boolean;
  /** For a git rename or copy: the other name, and how "patching file" names it. */
  readonly moved: { readonly from: string; readonly note: string } | null;
}

export function resolveTarget(
  header: PatchHeader,
  options: PatchOptions,
  workspace: Workspace,
  operand: { readonly name: string; readonly path: string } | null,
  report: Report,
): Resolved {
  const git = header.git;
  const oldAbsent = git?.newFile ?? namesAbsentFile(header.old);
  const newAbsent = git?.deletedFile ?? namesAbsentFile(header.new);
  const creates = options.reverse ? newAbsent : oldAbsent;
  const deletes = options.reverse ? oldAbsent : newAbsent;
  const found = (name: string): Target => ({ name, lookup: workspace.lookup(name), checked: true });

  if (operand !== null) {
    const target: Target = {
      name: operand.name,
      lookup: workspace.direct(operand.path),
      checked: false,
    };
    return { target, source: null, creates, deletes, moved: null };
  }

  if (git !== null) {
    const oldName = strip(oldAbsent ? git.oldPath : (header.old?.name ?? git.oldPath), options);
    const newName = strip(newAbsent ? git.newPath : (header.new?.name ?? git.newPath), options);
    const [from, to] = options.reverse ? [newName, oldName] : [oldName, newName];
    const targetName = deletes ? from : to;
    const target = targetName === null ? null : safeName(targetName, report);
    const destination = target === null ? null : found(target);
    if (!(git.rename || git.copy) || from === null || destination === null) {
      return { target: destination, source: null, creates, deletes, moved: null };
    }
    const origin = found(from);
    const verb = git.rename ? "renamed" : "copied";
    // A rename already made leaves only its destination, which is then patched in place.
    if (origin.lookup.safe && origin.lookup.stat === null && git.rename) {
      if (destination.lookup.safe && destination.lookup.stat !== null) {
        const moved = { from, note: ` (already renamed from ${quoteName(from)})` };
        return { target: destination, source: destination, creates, deletes, moved };
      }
    }
    const moved = { from, note: ` (${verb} from ${quoteName(from)})` };
    return { target: destination, source: origin, creates, deletes, moved };
  }

  const candidates: string[] = [];
  const add = (name: string | null): void => {
    const stripped = strip(name, options);
    if (stripped !== null && stripped !== "" && !candidates.includes(stripped)) {
      candidates.push(stripped);
    }
  };
  if (header.old !== null && !namesAbsentFile(header.old)) add(header.old.name);
  if (header.new !== null && !namesAbsentFile(header.new)) add(header.new.name);
  if (header.old === null && header.new === null) add(header.index);

  // GNU drops an absolute name silently and names a `..` one it found.
  const existing = candidates.filter((name) => {
    if (name.startsWith("/")) return false;
    const lookup = workspace.lookup(name);
    if (!lookup.safe || lookup.stat === null) return false;
    return safeName(name, report) !== null;
  });
  const chosen = bestName(existing);
  if (chosen !== null)
    return { target: found(chosen), source: null, creates, deletes, moved: null };

  if (creates || firstHunkCreates(header)) {
    const fewest = Math.min(...candidates.map((name) => workspace.missingDirectories(name)));
    const name = bestName(candidates.filter((c) => workspace.missingDirectories(c) === fewest));
    const safe = name === null ? null : safeName(name, report);
    return {
      target: safe === null ? null : found(safe),
      source: null,
      creates,
      deletes,
      moved: null,
    };
  }
  if (deletes) {
    const name = bestName(candidates);
    return {
      target: name === null ? null : found(name),
      source: null,
      creates,
      deletes,
      moved: null,
    };
  }
  return { target: null, source: null, creates, deletes, moved: null };
}

function strip(name: string | null, options: PatchOptions): string | null {
  return name === null ? null : stripName(name, options.strip);
}

function safeName(name: string, report: Report): string | null {
  if (!isDangerous(name)) return name;
  report.always(`Ignoring potentially dangerous file name ${quoteName(name)}\n`);
  return null;
}

function firstHunkCreates(header: PatchHeader): boolean {
  const line = header.hasHunks ? header.text.line(header.body) : null;
  return line !== null && /^@@ -0,0 /.test(lineText(line));
}
