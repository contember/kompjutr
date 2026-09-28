// jq's date builtins over glibc's strftime/strptime in the C locale and UTC,
// the only zone the shell has. Broken-down time is jq's array
// [year, month0, mday, hours, minutes, seconds, wday, yday]. Conversions
// outside the common C set are refused rather than guessed.

import { JqError, JqRefusal } from "../errors.js";
import { toInt } from "../paths.js";
import { isArray, isNumber, type JqValue, numberValue } from "../value.js";
import { type Natives, unary, withArgs } from "./native.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
const MAX_DATE_MS = 8.64e15;

interface Broken {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly weekday: number;
  readonly yearDay: number;
}

export function registerDates(natives: Natives): void {
  natives.set("gmtime/0", unary(gmtime));
  natives.set(
    "mktime/0",
    unary((value) => {
      if (!isArray(value)) throw new JqError("mktime requires array inputs");
      const broken = fromArray(value);
      if (broken === null) throw new JqError("mktime requires parsed datetime inputs");
      const seconds = timegm(broken);
      if (seconds === -1) throw new JqError("invalid gmtime representation");
      return seconds;
    }),
  );
  natives.set(
    "strftime/1",
    withArgs((value, [format]) => {
      let time = value;
      if (isNumber(time)) time = gmtime(time);
      else if (!isArray(time)) throw new JqError("strftime/1 requires parsed datetime inputs");
      if (typeof format !== "string") throw new JqError("strftime/1 requires a string format");
      const broken = isArray(time) ? fromArray(time) : null;
      if (broken === null) throw new JqError("strftime/1 requires parsed datetime inputs");
      return strftime(normalize(broken), format);
    }),
  );
  natives.set(
    "strptime/1",
    withArgs((value, [format]) => {
      if (typeof value !== "string" || typeof format !== "string") {
        throw new JqError("strptime/1 requires string inputs and arguments");
      }
      return strptime(value, format);
    }),
  );
}

function gmtime(value: JqValue): JqValue {
  if (!isNumber(value)) throw new JqError("gmtime() requires numeric inputs");
  const seconds = numberValue(value);
  const whole = Math.trunc(seconds);
  const ms = whole * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) {
    throw new JqRefusal("gmtime beyond the JavaScript date range is not supported");
  }
  const broken = fromEpoch(whole);
  return [
    broken.year,
    broken.month,
    broken.day,
    broken.hours,
    broken.minutes,
    broken.seconds + (seconds - Math.floor(seconds)),
    broken.weekday,
    broken.yearDay,
  ];
}

function fromEpoch(seconds: number): Broken {
  const date = new Date(seconds * 1000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  return {
    year,
    month,
    day,
    hours: date.getUTCHours(),
    minutes: date.getUTCMinutes(),
    seconds: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
    yearDay: Math.round((midnight(year, month, day) - midnight(year, 0, 1)) / 86_400_000),
  };
}

function midnight(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date.getTime();
}

/** jv2tm: up to eight numbers, each cast to int; a missing field stays zero. */
function fromArray(value: readonly JqValue[]): Broken | null {
  const fields = [1900, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < 8 && index < value.length; index++) {
    const item = value[index] ?? null;
    if (!isNumber(item) || Number.isNaN(numberValue(item))) return null;
    fields[index] = toInt(numberValue(item) - (index === 0 ? 1900 : 0)) + (index === 0 ? 1900 : 0);
  }
  const [
    year = 0,
    month = 0,
    day = 0,
    hours = 0,
    minutes = 0,
    seconds = 0,
    weekday = 0,
    yearDay = 0,
  ] = fields;
  return { year, month, day, hours, minutes, seconds, weekday, yearDay };
}

function timegm(broken: Broken): number {
  const date = new Date(0);
  date.setUTCFullYear(broken.year, broken.month, broken.day);
  date.setUTCHours(broken.hours, broken.minutes, broken.seconds, 0);
  const ms = date.getTime();
  if (!Number.isFinite(ms))
    throw new JqRefusal("mktime beyond the JavaScript date range is not supported");
  return Math.floor(ms / 1000);
}

/** timegm's normalization: out-of-range fields roll over, wday and yday follow. */
function normalize(broken: Broken): Broken {
  return fromEpoch(timegm(broken));
}

function pad(value: number, width: number, fill = "0"): string {
  const text = String(Math.abs(value)).padStart(width, fill);
  return value < 0 ? `-${text}` : text;
}

function isoWeek(broken: Broken): { year: number; week: number } {
  const weekday = (broken.weekday + 6) % 7;
  const thursday = broken.yearDay - weekday + 3;
  const yearLength = (year: number): number =>
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 366 : 365;
  if (thursday < 0) {
    const previous = broken.year - 1;
    return { year: previous, week: Math.floor((thursday + yearLength(previous)) / 7) + 1 };
  }
  if (thursday >= yearLength(broken.year)) return { year: broken.year + 1, week: 1 };
  return { year: broken.year, week: Math.floor(thursday / 7) + 1 };
}

function strftime(broken: Broken, format: string): string {
  let out = "";
  for (let index = 0; index < format.length; index++) {
    const char = format.charAt(index);
    if (char !== "%") {
      out += char;
      continue;
    }
    index++;
    const spec = format.charAt(index);
    const expanded = conversion(broken, spec);
    if (expanded === null) throw new JqRefusal(`strftime conversion %${spec} is not supported`);
    out += expanded;
  }
  return out;
}

function conversion(t: Broken, spec: string): string | null {
  const hour12 = t.hours % 12 === 0 ? 12 : t.hours % 12;
  switch (spec) {
    case "a":
      return DAYS[t.weekday]?.slice(0, 3) ?? "?";
    case "A":
      return DAYS[t.weekday] ?? "?";
    case "b":
    case "h":
      return MONTHS[t.month]?.slice(0, 3) ?? "?";
    case "B":
      return MONTHS[t.month] ?? "?";
    case "c":
      return `${conversion(t, "a")} ${conversion(t, "b")} ${pad(t.day, 2, " ")} ${conversion(t, "T")} ${t.year}`;
    case "C":
      return pad(Math.floor(t.year / 100), 2);
    case "d":
      return pad(t.day, 2);
    case "D":
      return `${pad(t.month + 1, 2)}/${pad(t.day, 2)}/${pad(t.year % 100, 2)}`;
    case "e":
      return pad(t.day, 2, " ");
    case "F":
      return `${t.year}-${pad(t.month + 1, 2)}-${pad(t.day, 2)}`;
    case "g":
      return pad(isoWeek(t).year % 100, 2);
    case "G":
      return String(isoWeek(t).year);
    case "H":
      return pad(t.hours, 2);
    case "I":
      return pad(hour12, 2);
    case "j":
      return pad(t.yearDay + 1, 3);
    case "k":
      return pad(t.hours, 2, " ");
    case "l":
      return pad(hour12, 2, " ");
    case "m":
      return pad(t.month + 1, 2);
    case "M":
      return pad(t.minutes, 2);
    case "n":
      return "\n";
    case "p":
      return t.hours < 12 ? "AM" : "PM";
    case "P":
      return t.hours < 12 ? "am" : "pm";
    case "r":
      return `${pad(hour12, 2)}:${pad(t.minutes, 2)}:${pad(t.seconds, 2)} ${conversion(t, "p")}`;
    case "R":
      return `${pad(t.hours, 2)}:${pad(t.minutes, 2)}`;
    case "s":
      return String(timegm(t));
    case "S":
      return pad(t.seconds, 2);
    case "t":
      return "\t";
    case "T":
      return `${pad(t.hours, 2)}:${pad(t.minutes, 2)}:${pad(t.seconds, 2)}`;
    case "u":
      return String(t.weekday === 0 ? 7 : t.weekday);
    case "U":
      return pad(Math.floor((t.yearDay + 7 - t.weekday) / 7), 2);
    case "V":
      return pad(isoWeek(t).week, 2);
    case "w":
      return String(t.weekday);
    case "W":
      return pad(Math.floor((t.yearDay + 7 - ((t.weekday + 6) % 7)) / 7), 2);
    case "x":
      return conversion(t, "D");
    case "X":
      return conversion(t, "T");
    case "y":
      return pad(t.year % 100, 2);
    case "Y":
      return String(t.year);
    case "z":
      return "+0000";
    case "Z":
      return "GMT";
    case "%":
      return "%";
    default:
      return null;
  }
}

interface Parsed {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** glibc strptime over the common conversions; the rest are refused. */
function strptime(input: string, format: string): JqValue {
  const parsed: Parsed = { year: 0, month: 0, day: 0, hours: 0, minutes: 0, seconds: 0 };
  let at = 0;
  const fail = (): never => {
    throw new JqError(`date "${input}" does not match format "${format}"`);
  };
  const number = (digits: number, from: number, to: number): number => {
    while (/\s/.test(input.charAt(at))) at++;
    let value = 0;
    let read = 0;
    while (read < digits && /[0-9]/.test(input.charAt(at)) && (read === 0 || value * 10 <= to)) {
      value = value * 10 + Number(input.charAt(at));
      at++;
      read++;
    }
    if (read === 0 || value < from || value > to) fail();
    return value;
  };
  const name = (names: readonly string[]): number => {
    const rest = input.slice(at).toLowerCase();
    for (let index = 0; index < names.length; index++) {
      const full = (names[index] ?? "").toLowerCase();
      for (const candidate of [full, full.slice(0, 3)]) {
        if (rest.startsWith(candidate)) {
          at += candidate.length;
          return index;
        }
      }
    }
    return fail();
  };
  const apply = (spec: string): void => {
    switch (spec) {
      case "Y":
        parsed.year = number(4, 0, 9999);
        return;
      case "m":
        parsed.month = number(2, 1, 12) - 1;
        return;
      case "d":
      case "e":
        parsed.day = number(2, 1, 31);
        return;
      case "H":
        parsed.hours = number(2, 0, 23);
        return;
      case "M":
        parsed.minutes = number(2, 0, 59);
        return;
      case "S":
        parsed.seconds = number(2, 0, 61);
        return;
      case "y": {
        const year = number(2, 0, 99);
        parsed.year = year >= 69 ? 1900 + year : 2000 + year;
        return;
      }
      case "b":
      case "B":
      case "h":
        parsed.month = name(MONTHS);
        return;
      case "a":
      case "A":
        name(DAYS);
        return;
      case "T":
        apply("H");
        expect(":");
        apply("M");
        expect(":");
        apply("S");
        return;
      case "F":
        apply("Y");
        expect("-");
        apply("m");
        expect("-");
        apply("d");
        return;
      case "Z":
        while (input.charAt(at) !== "" && !/\s/.test(input.charAt(at))) at++;
        return;
      case "%":
        expect("%");
        return;
      default:
        throw new JqRefusal(`strptime conversion %${spec} is not supported`);
    }
  };
  const expect = (literal: string): void => {
    if (input.charAt(at) !== literal) fail();
    at++;
  };
  for (let index = 0; index < format.length; index++) {
    const char = format.charAt(index);
    if (/\s/.test(char)) {
      while (/\s/.test(input.charAt(at))) at++;
    } else if (char === "%") {
      index++;
      apply(format.charAt(index));
    } else expect(char);
  }
  const rest = input.slice(at);
  if (rest !== "" && !/^\s/.test(rest)) fail();
  const broken = normalizeFields(parsed);
  const out: JqValue[] = [
    parsed.year,
    parsed.month,
    parsed.day,
    parsed.hours,
    parsed.minutes,
    parsed.seconds,
    broken.weekday,
    broken.yearDay,
  ];
  if (rest !== "") out.push(rest);
  return out;
}

function normalizeFields(parsed: Parsed): Broken {
  return normalize({ ...parsed, weekday: 0, yearDay: 0 });
}
