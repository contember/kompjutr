export const MAX_REF_NAME_BYTES = 1_024;

export type RefTextProblem = "invalid-character" | "noncanonical-utf16" | "too-long";

export interface RefTextCheck {
  readonly bytes: number;
  readonly problem: RefTextProblem | null;
}

/** Validate bounded UTF-8 text without choosing a caller-specific error type. */
export function checkRefText(value: string, limit: number): RefTextCheck {
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
    if (bytes > limit) return { bytes, problem: "too-long" };
  }
  return { bytes, problem: null };
}

/** Git check-ref-format syntax after text encoding and length are validated. */
export function hasCanonicalRefSyntax(value: string): boolean {
  if (
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    return false;
  }
  for (const component of value.split("/")) {
    if (component.startsWith(".") || component.endsWith(".lock")) return false;
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || " ~^:?*[\\".includes(value[index] ?? "")) {
      return false;
    }
  }
  return true;
}
