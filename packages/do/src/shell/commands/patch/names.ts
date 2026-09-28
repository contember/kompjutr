// File names as GNU patch reads them from headers: optionally C-quoted,
// ended by whitespace unless a tab later separates a timestamp, with `-p`
// leading components stripped. A name without enough components, or
// `/dev/null`, names nothing.

import { decode } from "../../exec/bytes.js";

/** A header timestamp: absent or unparsed, near the epoch, or any other time. */
export type Stamp = "none" | "epoch" | "other";

export type Fetched =
  | { readonly kind: "none" }
  | { readonly kind: "devnull" }
  | {
      readonly kind: "name";
      readonly name: string;
      readonly timestr: Uint8Array | null;
      readonly stamp: Stamp;
    };

const TAB = 0x09;
const NEWLINE = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;

export function isSpace(byte: number | undefined): boolean {
  return byte === 0x20 || (byte !== undefined && byte >= 0x09 && byte <= 0x0d);
}

export function isBlank(byte: number | undefined): boolean {
  return byte === 0x20 || byte === TAB;
}

export function isDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

/**
 * GNU's `fetchname` over `line` from `at`. `stamped` headers (`---`, `+++`)
 * keep a timestamp; an `Index:` name followed by anything is ignored.
 */
export function fetchName(line: Uint8Array, at: number, strip: number, stamped: boolean): Fetched {
  let start = at;
  while (isSpace(line[start])) start++;
  let name: Uint8Array;
  let end: number;
  if (line[start] === QUOTE) {
    const parsed = parseCString(line, start);
    if (parsed === null) return { kind: "none" };
    name = parsed.bytes;
    end = parsed.end;
  } else {
    end = start;
    for (; end < line.length; end++) {
      if (!isSpace(line[end])) continue;
      // Spaces are part of the name only when a tab later separates a date.
      let run = end;
      while (line[run] !== TAB && isSpace(line[run + 1])) run++;
      if (line[run] !== TAB && line.indexOf(stamped ? TAB : NEWLINE, run + 1) !== -1) continue;
      break;
    }
    name = line.subarray(start, end);
  }
  const text = decode(name);
  if (text === "/dev/null") return { kind: "devnull" };
  const stripped = stripLeading(text, strip);
  if (stripped === null) return { kind: "none" };

  let timestr: Uint8Array | null = null;
  if (stamped) {
    let limit = line.length;
    if (limit > end && line[limit - 1] === NEWLINE) limit--;
    if (limit > end && line[limit - 1] === CR) limit--;
    timestr = line.subarray(end, limit);
  }
  let stamp: Stamp = "none";
  if (line[end] !== NEWLINE && end < line.length) {
    if (!stamped) return { kind: "none" };
    stamp = parseStamp(decode(line.subarray(end)));
  }
  return { kind: "name", name: stripped, timestr, stamp };
}

/** GNU's `parse_name` for `diff --git` operands: quoted, or up to whitespace. */
export function parseName(
  line: Uint8Array,
  at: number,
  strip: number,
): { readonly name: string | null; readonly end: number } {
  let start = at;
  while (isSpace(line[start])) start++;
  let bytes: Uint8Array;
  let end: number;
  if (line[start] === QUOTE) {
    const parsed = parseCString(line, start);
    if (parsed === null) return { name: null, end: start };
    bytes = parsed.bytes;
    end = parsed.end;
  } else {
    end = start;
    while (end < line.length && !isSpace(line[end])) end++;
    bytes = line.subarray(start, end);
  }
  return { name: stripLeading(decode(bytes), strip), end };
}

/**
 * Strip `strip` leading components (all but the last when negative). Null
 * when there are too few slashes, or nothing would remain.
 */
export function stripLeading(name: string, strip: number): string | null {
  let remaining = strip;
  let from = 0;
  for (let index = 0; index < name.length; index++) {
    if (name.charAt(index) !== "/") continue;
    while (name.charAt(index + 1) === "/") index++;
    if (strip < 0 || --remaining >= 0) from = index + 1;
  }
  if ((strip < 0 || remaining <= 0) && from < name.length) return name.slice(from);
  return null;
}

const ESCAPES: ReadonlyMap<number, number> = new Map([
  [0x61, 0x07],
  [0x62, 0x08],
  [0x66, 0x0c],
  [0x6e, 0x0a],
  [0x72, 0x0d],
  [0x74, 0x09],
  [0x76, 0x0b],
  [BACKSLASH, BACKSLASH],
  [QUOTE, QUOTE],
]);

function parseCString(
  line: Uint8Array,
  at: number,
): { readonly bytes: Uint8Array; readonly end: number } | null {
  const out: number[] = [];
  let index = at + 1;
  for (;;) {
    const byte = line[index++];
    if (byte === undefined || byte === 0) return null;
    if (byte === QUOTE) return { bytes: Uint8Array.from(out), end: index };
    if (byte !== BACKSLASH) {
      out.push(byte);
      continue;
    }
    const escaped = line[index++];
    if (escaped === undefined) return null;
    const simple = ESCAPES.get(escaped);
    if (simple !== undefined) {
      out.push(simple);
      continue;
    }
    if (escaped < 0x30 || escaped > 0x33) return null;
    const second = line[index++];
    const third = line[index++];
    if (!isOctal(second) || !isOctal(third)) return null;
    const value = ((escaped - 0x30) << 6) | ((second - 0x30) << 3) | (third - 0x30);
    if (value === 0) return null;
    out.push(value);
  }
}

function isOctal(byte: number | undefined): byte is number {
  return byte !== undefined && byte >= 0x30 && byte <= 0x37;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO =
  /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(?:([+-])(\d{2}):?(\d{2})|Z|UTC|GMT)?\s*$/i;
const CTIME =
  /^\s*(?:[a-z]{3}\s+)?([a-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*(?:([+-])(\d{2}):?(\d{2})|UTC|GMT)?\s*$/i;

/**
 * Only whether a timestamp is the epoch matters: `diff -N` dates a missing
 * file there. GNU accepts any time within a day of it, for local offsets.
 */
function parseStamp(text: string): Stamp {
  let seconds: number | null = null;
  const iso = ISO.exec(text);
  if (iso !== null) {
    seconds = epochSeconds(iso[1], iso[2], iso[3], iso[4], iso[5], iso[6], iso[7], iso[8], iso[9]);
  } else {
    const ctime = CTIME.exec(text);
    const month = ctime === null ? -1 : MONTHS.indexOf((ctime[1] ?? "").toLowerCase());
    if (ctime !== null && month >= 0) {
      seconds = epochSeconds(
        ctime[6],
        String(month + 1),
        ctime[2],
        ctime[3],
        ctime[4],
        ctime[5],
        ctime[7],
        ctime[8],
        ctime[9],
      );
    }
  }
  if (seconds === null) return "none";
  return seconds > -25 * 3600 && seconds < 26 * 3600 ? "epoch" : "other";
}

function epochSeconds(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
  hour: string | undefined,
  minute: string | undefined,
  second: string | undefined,
  sign: string | undefined,
  offsetHours: string | undefined,
  offsetMinutes: string | undefined,
): number {
  const utc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  );
  const offset = (Number(offsetHours ?? 0) * 60 + Number(offsetMinutes ?? 0)) * 60;
  return utc / 1000 - (sign === "-" ? -offset : offset);
}

const UNSAFE = /[\s!"$&'()*;<=>?[\\\]^`{|}]|^[#~]/;

/** GNU's default `shell` quoting style for file names in messages. */
export function quote(name: string): string {
  if (name === "") return "''";
  if (!UNSAFE.test(name)) return name;
  return `'${name.replaceAll("'", "'\\''")}'`;
}
