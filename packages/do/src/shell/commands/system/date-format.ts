// `date +FORMAT` conversions as uutils 0.2.2 renders them through jiff's
// strftime. jiff differs from glibc in ways the parity suite pins: text fields
// ignore width, a width pads digits and leaves the sign outside it, `%N`'s
// width is a precision, only one flag is read, and `%y` refuses years outside
// 1969..2068.

import { type Fields, isoWeek } from "./date-time.js";

export type Formatted =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "unsupported"; readonly directive: string };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const FLAGS = "-_0^#";
// Directives jiff knows that this shell does not render: locale forms, `%Q`,
// and the fractional-second spellings.
const UNSUPPORTED = new Set(["c", "x", "X", "r", "Q", "f", "."]);

interface Directive {
  readonly flag: string | null;
  readonly width: number | null;
  readonly colons: number;
  readonly specifier: string;
}

export function strftime(format: string, fields: Fields): Formatted {
  let text = "";
  let index = 0;
  while (index < format.length) {
    const char = format.charAt(index);
    if (char !== "%") {
      text += char;
      index++;
      continue;
    }
    const parsed = readDirective(format, index + 1);
    if (parsed.kind !== "directive") return parsed;
    index = parsed.next;
    const rendered = render(parsed.directive, fields);
    if (rendered.kind !== "text") return rendered;
    text += rendered.text;
  }
  return { kind: "text", text };
}

type ReadResult =
  | { readonly kind: "directive"; readonly directive: Directive; readonly next: number }
  | Exclude<Formatted, { kind: "text" }>;

function readDirective(format: string, start: number): ReadResult {
  let index = start;
  if (index >= format.length) {
    return {
      kind: "invalid",
      detail: "invalid format string, expected byte after '%', but found end of format string",
    };
  }
  let flag: string | null = null;
  if (FLAGS.includes(format.charAt(index))) {
    flag = format.charAt(index);
    index++;
    if (index >= format.length) {
      return {
        kind: "invalid",
        detail: `expected to find specifier directive after flag "${flag}", but found end of format string`,
      };
    }
  }
  let digits = "";
  while (index < format.length && /[0-9]/.test(format.charAt(index))) {
    digits += format.charAt(index);
    index++;
  }
  const width = digits === "" ? null : Number(digits);
  if (index >= format.length) {
    return {
      kind: "invalid",
      detail: `expected to find specifier directive after width ${digits}, but found end of format string`,
    };
  }
  let colons = 0;
  while (index < format.length && format.charAt(index) === ":") {
    colons++;
    index++;
  }
  const specifier = format.charAt(index);
  if (colons > 0 && (colons > 3 || specifier !== "z")) {
    return { kind: "unsupported", directive: `%${":".repeat(colons)}${specifier}` };
  }
  return { kind: "directive", directive: { flag, width, colons, specifier }, next: index + 1 };
}

function render(directive: Directive, fields: Fields): Formatted {
  const { specifier } = directive;
  const number = (value: number, natural: number, pad: "0" | " " = "0"): Formatted => ({
    kind: "text",
    text: padNumber(value, natural, pad, directive),
  });
  const word = (value: string, lowerable = false): Formatted => ({
    kind: "text",
    text:
      directive.flag === "^"
        ? value.toUpperCase()
        : directive.flag === "#" && lowerable
          ? value.toLowerCase()
          : value,
  });
  const composite = (format: string): Formatted => strftime(format, fields);
  const hour12 = fields.hour % 12 === 0 ? 12 : fields.hour % 12;

  switch (specifier) {
    case "Y":
      return number(fields.year, 4);
    case "C":
      return number(Math.floor(fields.year / 100), 2);
    case "y":
      return twoDigitYear("%y", fields.year, directive);
    case "m":
      return number(fields.month, 2);
    case "d":
      return number(fields.day, 2);
    case "e":
      return number(fields.day, 2, " ");
    case "H":
      return number(fields.hour, 2);
    case "k":
      return number(fields.hour, 2, " ");
    case "I":
      return number(hour12, 2);
    case "l":
      return number(hour12, 2, " ");
    case "M":
      return number(fields.minute, 2);
    case "S":
      return number(fields.second, 2);
    case "j":
      return number(fields.dayOfYear, 3);
    case "s":
      return number(fields.instant.seconds, 1, " ");
    case "u":
      return number(fields.weekday === 0 ? 7 : fields.weekday, 1, " ");
    case "w":
      return number(fields.weekday, 1, " ");
    case "q":
      return number(Math.floor((fields.month - 1) / 3) + 1, 1, " ");
    case "U":
      return number(Math.floor((fields.dayOfYear - 1 + 7 - fields.weekday) / 7), 2);
    case "W":
      return number(Math.floor((fields.dayOfYear - 1 + 7 - ((fields.weekday + 6) % 7)) / 7), 2);
    case "V":
      return number(isoWeek(fields).week, 2);
    case "G":
      return number(isoWeek(fields).year, 4);
    case "g":
      return twoDigitYear("%g", isoWeek(fields).year, directive);
    case "N": {
      const precision = Math.min(directive.width ?? 9, 9);
      return {
        kind: "text",
        text: String(fields.instant.nanos).padStart(9, "0").slice(0, precision),
      };
    }
    case "a":
      return word((WEEKDAYS[fields.weekday] ?? "").slice(0, 3));
    case "A":
      return word(WEEKDAYS[fields.weekday] ?? "");
    case "b":
    case "h":
      return word((MONTHS[fields.month - 1] ?? "").slice(0, 3));
    case "B":
      return word(MONTHS[fields.month - 1] ?? "");
    case "p":
      return word(fields.hour < 12 ? "AM" : "PM", true);
    case "P":
      return word(fields.hour < 12 ? "am" : "pm", true);
    case "Z":
      return word("UTC", true);
    case "z":
      return {
        kind: "text",
        text: ["+0000", "+00:00", "+00:00:00", "+00"][directive.colons] ?? "",
      };
    case "F":
      return composite("%Y-%m-%d");
    case "D":
      return composite("%m/%d/%y");
    case "T":
      return composite("%H:%M:%S");
    case "R":
      return composite("%H:%M");
    case "n":
      return { kind: "text", text: "\n" };
    case "t":
      return { kind: "text", text: "\t" };
    case "%":
      return { kind: "text", text: "%" };
    default:
      if (UNSUPPORTED.has(specifier)) return { kind: "unsupported", directive: `%${specifier}` };
      return { kind: "invalid", detail: `found unrecognized specifier directive %${specifier}` };
  }
}

function twoDigitYear(name: string, year: number, directive: Directive): Formatted {
  if (year < 1969 || year > 2068) {
    return {
      kind: "invalid",
      detail: `${name} failed: formatting a 2-digit year requires that it be in the inclusive range 1969 to 2068, but got ${year}`,
    };
  }
  return { kind: "text", text: padNumber(year % 100, 2, "0", directive) };
}

function padNumber(value: number, natural: number, pad: "0" | " ", directive: Directive): string {
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.abs(value));
  if (directive.flag === "-") return `${sign}${digits}`;
  const width = directive.width ?? natural;
  const fill = directive.flag === "_" ? " " : directive.flag === "0" ? "0" : pad;
  return `${sign}${digits.padStart(width, fill)}`;
}
