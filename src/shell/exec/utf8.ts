import { ShellLimitError } from "./context.js";

export function addUtf8Bytes(current: number, value: string, label: string): number {
  const bytes = utf8Bytes(value);
  if (bytes > Number.MAX_SAFE_INTEGER - current) {
    throw new ShellLimitError("arguments", `${label} has an invalid retained size`);
  }
  return current + bytes;
}

/** Match TextEncoder's replacement of unpaired surrogates without allocating. */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}
