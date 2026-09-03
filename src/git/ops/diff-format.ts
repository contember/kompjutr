import { utf8Decoder, ZERO_OID } from "../common/bytes.js";
import { diffText } from "../diff/index.js";
import { isBinary } from "../diff/lines.js";
import { appendCombinedDiff } from "./diff-combined.js";
import { diffHeaderPath } from "./diff-path-format.js";
import {
  DEFAULT_ABBREV,
  type DiffFormatOptions,
  DiffOutput,
  endpointBytes,
  isCombinedFileChange,
  isUnmergedFileChange,
  type PatchChange,
  type TreeDiffOptions,
} from "./diff-types.js";

export function renderPatch(
  changes: Iterable<PatchChange>,
  options: TreeDiffOptions,
  formatOptions: DiffFormatOptions,
): string {
  const abbrev = options.abbrev ?? DEFAULT_ABBREV;
  const out = new DiffOutput(formatOptions.maxOutputBytes);
  for (const change of changes) {
    if (isUnmergedFileChange(change)) {
      out.append(`* Unmerged path ${diffHeaderPath(change.path, "", formatOptions)}\n`);
      continue;
    }
    if (isCombinedFileChange(change)) {
      appendCombinedDiff(out, change, abbrev, options.context, formatOptions);
      continue;
    }
    const before = change.before;
    const after = change.after;
    if (
      change.originalPath !== undefined &&
      change.similarity !== undefined &&
      before !== null &&
      after !== null
    ) {
      let header =
        `diff --git ${diffHeaderPath(change.originalPath, "a/", formatOptions)} ` +
        `${diffHeaderPath(change.path, "b/", formatOptions)}\n`;
      if (before.mode !== after.mode) {
        header += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
      }
      out.append(header);
      out.append(`similarity index ${change.similarity}%\n`);
      out.append(`rename from ${diffHeaderPath(change.originalPath, "", formatOptions)}\n`);
      out.append(`rename to ${diffHeaderPath(change.path, "", formatOptions)}\n`);
      continue;
    }
    const left = before === null ? "/dev/null" : diffHeaderPath(change.path, "a/", formatOptions);
    const right = after === null ? "/dev/null" : diffHeaderPath(change.path, "b/", formatOptions);

    let header =
      `diff --git ${diffHeaderPath(change.path, "a/", formatOptions)} ` +
      `${diffHeaderPath(change.path, "b/", formatOptions)}\n`;
    let headerLines = 1;
    if (before === null && after !== null) {
      header += `new file mode ${after.mode}\n`;
      headerLines++;
    } else if (after === null && before !== null) {
      header += `deleted file mode ${before.mode}\n`;
      headerLines++;
    } else if (before !== null && after !== null && before.mode !== after.mode) {
      header += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
      headerLines += 2;
    }

    const oldOid = before?.oid ?? ZERO_OID;
    const newOid = after?.oid ?? ZERO_OID;
    if (oldOid !== newOid) {
      const sameMode = before !== null && after !== null && before.mode === after.mode;
      header +=
        `index ${oldOid.slice(0, abbrev)}..${newOid.slice(0, abbrev)}` +
        `${sameMode && before !== null ? ` ${before.mode}` : ""}\n`;
      headerLines++;
    }

    if (oldOid === newOid) {
      if (headerLines > 1) out.append(header);
      continue;
    }
    const oldBytes = before === null ? new Uint8Array(0) : endpointBytes(before);
    const newBytes = after === null ? new Uint8Array(0) : endpointBytes(after);
    if (isBinary(oldBytes) || isBinary(newBytes)) {
      out.append(header);
      out.append(`Binary files ${left} and ${right} differ\n`);
      continue;
    }
    const text = diffText(utf8Decoder.decode(oldBytes), utf8Decoder.decode(newBytes), {
      context: options.context,
    });
    if (text.hunks === "") {
      continue;
    }
    out.append(header);
    out.append(`--- ${left}\n`);
    out.append(`+++ ${right}\n`);
    out.append(text.hunks);
  }
  return out.finish();
}
