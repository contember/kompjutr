// `date`. The clock is `ShellOptions.now` and the only zone is UTC: a TZ other
// than UTC is refused rather than silently rendered as UTC. Setting the
// clock, `-f`, `-r`, and the relative `-d` grammar (`yesterday`, `2 days ago`)
// are refused; `-d` admits `@EPOCH[.frac]` and ISO-8601 dates and times.

import { line, one } from "../../exec/bytes.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  fail,
  result,
} from "../../exec/context.js";
import { type CommandSpec, has, last, parseCommandLine, parseFailure, unexpected } from "./clap.js";
import { strftime } from "./date-format.js";
import { fieldsOf, type Instant, instantFromMilliseconds, parseDateString } from "./date-time.js";

const FAILED = 1;
const DEFAULT_FORMAT = "%a %b %e %H:%M:%S %Z %Y";
const RFC_EMAIL = "%a, %d %b %Y %H:%M:%S %z";
const ISO_FORMATS: Readonly<Record<string, string>> = {
  date: "%Y-%m-%d",
  hours: "%Y-%m-%dT%H%:z",
  minutes: "%Y-%m-%dT%H:%M%:z",
  seconds: "%Y-%m-%dT%H:%M:%S%:z",
  ns: "%Y-%m-%dT%H:%M:%S,%N%:z",
};
const RFC_3339_FORMATS: Readonly<Record<string, string>> = {
  date: "%Y-%m-%d",
  seconds: "%Y-%m-%d %H:%M:%S%:z",
  ns: "%Y-%m-%d %H:%M:%S.%N%:z",
};
// TZ values that already mean UTC.
const UTC_ZONES = new Set(["", "UTC", "UTC0"]);

// The reference's usage block is its full --help text; the refusal keeps
// clap's message and omits that block.
const SPEC: CommandSpec = {
  usage: null,
  options: [
    {
      name: "date",
      short: ["d"],
      value: "required",
      valueName: "STRING",
      repeatable: true,
      hyphenValues: true,
    },
    {
      name: "iso-8601",
      short: ["I"],
      value: "optional",
      valueName: "FMT",
      possible: ["date", "hours", "minutes", "seconds", "ns"],
    },
    { name: "rfc-email", aliases: ["rfc-822", "rfc-2822"], short: ["R"] },
    { name: "rfc-3339", value: "required", valueName: "FMT", possible: ["date", "seconds", "ns"] },
    { name: "universal", aliases: ["utc", "uct"], short: ["u"] },
    { name: "file", short: ["f"], value: "required", valueName: "DATEFILE", refused: true },
    { name: "reference", short: ["r"], value: "required", valueName: "FILE", refused: true },
    { name: "set", short: ["s"], value: "required", valueName: "STRING", refused: true },
    { name: "debug", refused: true },
    { name: "help", short: ["h"], refused: true },
    { name: "version", short: ["V"], refused: true },
  ],
};

export const date: Command = (context) => {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(context.argv, SPEC);
    const extra = parsed.operands[1];
    if (extra !== undefined) throw unexpected(extra, SPEC);
  } catch (error) {
    const failed = parseFailure(context, error, FAILED);
    if (failed !== null) return failed;
    throw error;
  }

  const operand = parsed.operands[0];
  if (operand !== undefined && !operand.startsWith("+")) {
    return fail(context, `operand '${operand}' is not supported: setting the clock is refused`);
  }

  const formats: string[] = [];
  if (operand !== undefined) formats.push(operand.slice(1));
  const iso = last(parsed, "iso-8601");
  if (iso !== undefined) formats.push(ISO_FORMATS[iso ?? "date"] ?? "");
  const rfc3339 = last(parsed, "rfc-3339");
  if (rfc3339 !== undefined && rfc3339 !== null) formats.push(RFC_3339_FORMATS[rfc3339] ?? "");
  if (has(parsed, "rfc-email")) formats.push(RFC_EMAIL);
  if (formats.length > 1) return fail(context, "multiple output formats specified");

  const zone = context.env?.TZ;
  if (!has(parsed, "universal") && zone !== undefined && !UTC_ZONES.has(zone)) {
    return fail(context, `time zone '${zone}' is not supported: the shell has only UTC`);
  }

  const described = last(parsed, "date");
  let instant: Instant;
  if (described === undefined || described === null) {
    instant = instantFromMilliseconds(context.now());
  } else {
    const parsedDate = parseDateString(described);
    if (parsedDate.kind === "invalid") return fail(context, `invalid date '${described}'`);
    if (parsedDate.kind === "unsupported") {
      return fail(
        context,
        `date string '${described}' is not supported: use @EPOCH or an ISO-8601 date and time`,
      );
    }
    instant = parsedDate.instant;
  }

  return render(context, formats[0] ?? DEFAULT_FORMAT, instant);
};

function render(context: CommandContext, format: string, instant: Instant): CommandResult {
  const formatted = strftime(format, fieldsOf(instant));
  if (formatted.kind === "unsupported") {
    return fail(context, `conversion '${formatted.directive}' is not supported`);
  }
  if (formatted.kind === "invalid") {
    return fail(
      context,
      `invalid format '${format}' (strftime formatting failed: ${formatted.detail})`,
    );
  }
  return result(one(line(formatted.text)));
}
