export const MAX_REF_NAME_BYTES = 1_024;

export type RefTextProblem = "invalid-character" | "noncanonical-utf16" | "too-long";

export interface RefTextCheck {
  readonly bytes: number;
  readonly problem: RefTextProblem | null;
}

/** Validate canonical UTF-8 text, with an optional caller-owned wire limit. */
export function checkRefText(value: string, limit?: number): RefTextCheck {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0 || unit === 0x0a || unit === 0x0d) {
      return { bytes, problem: "invalid-character" };
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) {
        return { bytes, problem: "noncanonical-utf16" };
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { bytes, problem: "noncanonical-utf16" };
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (limit !== undefined && bytes > limit) return { bytes, problem: "too-long" };
  }
  return { bytes, problem: null };
}

/** Git check-ref-format syntax after text encoding and length are validated. */
export function hasCanonicalRefSyntax(value: string, start = 0, end = value.length): boolean {
  return hasCanonicalRefSyntaxWithWildcard(value, -1, start, end);
}

/** Validate one refspec pattern without constructing a substituted copy. */
export function hasCanonicalRefPatternSyntax(value: string, wildcard: number): boolean {
  return hasCanonicalRefSyntaxWithWildcard(value, wildcard, 0, value.length);
}

function hasCanonicalRefSyntaxWithWildcard(
  value: string,
  wildcard: number,
  start: number,
  end: number,
): boolean {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= end ||
    end > value.length
  ) {
    return false;
  }
  if (
    (end - start === 1 && value.charCodeAt(start) === 0x40) ||
    value.charCodeAt(start) === 0x2f ||
    value.charCodeAt(end - 1) === 0x2f ||
    value.charCodeAt(end - 1) === 0x2e ||
    value.startsWith("ref: ", start)
  ) {
    return false;
  }
  let componentStart = start;
  for (let index = start; index < end; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x2f) {
      if (
        index === componentStart ||
        value.charCodeAt(componentStart) === 0x2e ||
        value.endsWith(".lock", index)
      ) {
        return false;
      }
      componentStart = index + 1;
      continue;
    }
    const next = value.charCodeAt(index + 1);
    if ((code === 0x2e && next === 0x2e) || (code === 0x40 && next === 0x7b)) return false;
    if (
      code < 0x20 ||
      code === 0x7f ||
      (" ~^:?*[\\".includes(value[index] ?? "") && index !== wildcard)
    ) {
      return false;
    }
  }
  return value.charCodeAt(componentStart) !== 0x2e && !value.endsWith(".lock", end);
}
