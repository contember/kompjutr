// UTC calendar arithmetic and the `-d` strings `date` admits. UTC is the only
// zone the shell has, so an instant is seconds and nanoseconds since the epoch
// and every field is derived from it with integer arithmetic.

export interface Instant {
  readonly seconds: number;
  /** 0..999,999,999, always non-negative: -1.5 s is -2 s plus 500 ms. */
  readonly nanos: number;
}

export interface Fields {
  readonly instant: Instant;
  readonly year: number;
  /** 1..12 */
  readonly month: number;
  /** 1..31 */
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 is Sunday. */
  readonly weekday: number;
  /** 1..366 */
  readonly dayOfYear: number;
}

// jiff's `Timestamp` range, which is the reference's: years -9999..9999.
const MIN_SECONDS = -377_705_116_800;
const MAX_SECONDS = 253_402_207_199;
const SECONDS_PER_DAY = 86_400;

export function instantFromMilliseconds(milliseconds: number): Instant {
  const seconds = Math.floor(milliseconds / 1000);
  return { seconds, nanos: Math.round((milliseconds - seconds * 1000) * 1_000_000) };
}

export function fieldsOf(instant: Instant): Fields {
  const days = Math.floor(instant.seconds / SECONDS_PER_DAY);
  const secondOfDay = instant.seconds - days * SECONDS_PER_DAY;
  const { year, month, day } = civilFromDays(days);
  return {
    instant,
    year,
    month,
    day,
    hour: Math.floor(secondOfDay / 3600),
    minute: Math.floor((secondOfDay % 3600) / 60),
    second: secondOfDay % 60,
    weekday: mod(days + 4, 7),
    dayOfYear: days - daysFromCivil(year, 1, 1) + 1,
  };
}

export function inRange(instant: Instant): boolean {
  return instant.seconds >= MIN_SECONDS && instant.seconds <= MAX_SECONDS;
}

/** ISO 8601 week-numbering year and week of `fields`. */
export function isoWeek(fields: Fields): { readonly year: number; readonly week: number } {
  const isoWeekday = fields.weekday === 0 ? 7 : fields.weekday;
  const thursday = daysFromCivil(fields.year, fields.month, fields.day) - isoWeekday + 4;
  const year = civilFromDays(thursday).year;
  const week = Math.floor((thursday - daysFromCivil(year, 1, 1)) / 7) + 1;
  return { year, week };
}

export type DateString =
  | { readonly kind: "instant"; readonly instant: Instant }
  | { readonly kind: "invalid" }
  | { readonly kind: "unsupported" };

const EPOCH = /^@([+-]?)([0-9]{1,15})(?:\.([0-9]+))?$/;
const ISO =
  /^([0-9]{4,})-([0-9]{1,2})-([0-9]{1,2})(?:[Tt ]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2})(?:[.,]([0-9]+))?)?(?:\s*(Z|z|UTC|[+-][0-9]{2}(?::?[0-9]{2})?))?)?$/;

/** A `-d` string: `@EPOCH[.frac]` or an ISO-8601 date with an optional time and offset. */
export function parseDateString(text: string): DateString {
  const trimmed = text.trim();
  const epoch = EPOCH.exec(trimmed);
  if (epoch !== null) {
    const [, sign = "", whole = "0", fraction = ""] = epoch;
    const magnitude = { seconds: Number(whole), nanos: nanosOf(fraction) };
    const instant = sign === "-" ? negate(magnitude) : magnitude;
    return inRange(instant) ? { kind: "instant", instant } : { kind: "invalid" };
  }
  // The epoch grammar is complete: anything else after `@` is not a number.
  if (trimmed.startsWith("@")) return { kind: "invalid" };

  const iso = ISO.exec(trimmed);
  if (iso === null) return { kind: "unsupported" };
  const [, y = "", mo = "", d = "", h = "0", mi = "0", s = "0", fraction = "", zone = ""] = iso;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (year > 9999 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { kind: "invalid" };
  }
  if (hour > 23 || minute > 59 || second > 59) return { kind: "invalid" };
  const offset = offsetSeconds(zone);
  if (offset === null) return { kind: "invalid" };
  const seconds =
    daysFromCivil(year, month, day) * SECONDS_PER_DAY + hour * 3600 + minute * 60 + second - offset;
  const instant = { seconds, nanos: nanosOf(fraction) };
  return inRange(instant) ? { kind: "instant", instant } : { kind: "invalid" };
}

function offsetSeconds(zone: string): number | null {
  if (zone === "" || zone === "Z" || zone === "z" || zone === "UTC") return 0;
  const digits = zone.slice(1).replace(":", "");
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
  if (hours > 23 || minutes > 59) return null;
  const magnitude = hours * 3600 + minutes * 60;
  return zone.startsWith("-") ? -magnitude : magnitude;
}

function nanosOf(fraction: string): number {
  return Number(fraction.slice(0, 9).padEnd(9, "0"));
}

function negate(instant: Instant): Instant {
  return instant.nanos === 0
    ? { seconds: -instant.seconds, nanos: 0 }
    : { seconds: -instant.seconds - 1, nanos: 1_000_000_000 - instant.nanos };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function mod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

// Howard Hinnant's civil-calendar algorithms, proleptic Gregorian.
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shifted = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1;
  const month = shifted < 10 ? shifted + 3 : shifted - 9;
  return { year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day };
}
