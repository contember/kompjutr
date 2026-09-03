import { GitError } from "../common/errors.js";
import type { CommitView } from "../ops/reads.js";
import { gitCliUtf8ByteLength } from "./result.js";

const MAX_FORMAT_OPERATIONS = 1_000_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatLog(
  commits: readonly CommitView[],
  format:
    | { readonly kind: "default" }
    | { readonly kind: "oneline" }
    | {
        readonly kind: "template";
        readonly template: string;
      },
  maximum: number,
): string {
  const out = new BoundedLogOutput(maximum);
  if (format.kind === "template" && format.template === "") return "";
  let operations = 0;
  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]!;
    if (format.kind === "default") {
      if (index > 0) out.append("\n");
      appendDefaultCommit(out, commit);
    } else if (format.kind === "oneline") {
      out.appendSlice(commit.oid, 0, Math.min(7, commit.oid.length));
      out.append(" ");
      appendSubject(out, commit.message);
      out.append("\n");
    } else {
      operations = appendTemplate(out, commit, format.template, operations);
      out.append("\n");
    }
  }
  return out.finish();
}

class BoundedLogOutput {
  #bytes = 0;
  readonly #chunks: string[] = [];

  constructor(private readonly maximum: number) {}

  append(value: string): void {
    if (value === "") return;
    const bytes = gitCliUtf8ByteLength(value, "git CLI log output", false);
    this.#append(value, bytes);
  }

  appendSlice(value: string, start: number, end = value.length): void {
    if (start === end) return;
    const bytes = utf8RangeBytes(value, start, end);
    this.#admit(bytes);
    const chunk = value.slice(start, end);
    this.#chunks.push(chunk);
  }

  #append(value: string, bytes: number): void {
    this.#admit(bytes);
    this.#chunks.push(value);
  }

  #admit(bytes: number): void {
    if (bytes > this.maximum - this.#bytes) {
      throw new GitError("E2BIG", `git CLI log output exceeds ${this.maximum} bytes`);
    }
    this.#bytes += bytes;
  }

  finish(): string {
    return this.#chunks.join("");
  }
}

function appendDefaultCommit(out: BoundedLogOutput, commit: CommitView): void {
  out.append("commit ");
  out.append(commit.oid);
  out.append("\n");
  if (commit.parent.length > 1) {
    out.append("Merge: ");
    for (let index = 0; index < commit.parent.length; index++) {
      if (index > 0) out.append(" ");
      const oid = commit.parent[index]!;
      out.appendSlice(oid, 0, Math.min(7, oid.length));
    }
    out.append("\n");
  }
  out.append("Author: ");
  out.append(commit.author.name);
  out.append(" <");
  out.append(commit.author.email);
  out.append(">\nDate:   ");
  out.append(mediumDate(commit.author));
  out.append("\n");
  let messageEnd = commit.message.length;
  while (messageEnd > 0 && commit.message.charCodeAt(messageEnd - 1) === 0x0a) messageEnd--;
  if (messageEnd === 0) return;
  out.append("\n");
  let lineStart = 0;
  while (lineStart < messageEnd) {
    const newline = commit.message.indexOf("\n", lineStart);
    const lineEnd = newline < 0 || newline > messageEnd ? messageEnd : newline;
    out.append("    ");
    out.appendSlice(commit.message, lineStart, lineEnd);
    out.append("\n");
    lineStart = lineEnd + 1;
  }
}

function mediumDate(person: CommitView["author"]): string {
  if (!Number.isSafeInteger(person.timestamp) || !Number.isSafeInteger(person.timezoneOffset)) {
    throw new GitError("EINVAL", "git CLI log identity has an invalid date");
  }
  const localSeconds = person.timestamp - person.timezoneOffset * 60;
  const milliseconds = localSeconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new GitError("EINVAL", "git CLI log identity date is outside the supported range");
  }
  const date = new Date(milliseconds);
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  if (weekday === undefined || month === undefined || Number.isNaN(date.getTime())) {
    throw new GitError("EINVAL", "git CLI log identity date is outside the supported range");
  }
  return (
    `${weekday} ${month} ${date.getUTCDate()} ` +
    `${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:` +
    `${twoDigits(date.getUTCSeconds())} ${date.getUTCFullYear()} ${timezone(person.timezoneOffset)}`
  );
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function timezone(offsetMinutes: number): string {
  const east = -offsetMinutes;
  const sign = east < 0 ? "-" : "+";
  const absolute = Math.abs(east);
  return `${sign}${twoDigits(Math.floor(absolute / 60))}${twoDigits(absolute % 60)}`;
}

function appendSubject(out: BoundedLogOutput, message: string): void {
  let appended = false;
  let lineStart = 0;
  while (lineStart <= message.length) {
    const newline = message.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? message.length : newline;
    let trimmedEnd = lineEnd;
    while (trimmedEnd > lineStart && isTrimWhitespace(message.charCodeAt(trimmedEnd - 1))) {
      trimmedEnd--;
    }
    if (trimmedEnd === lineStart) {
      if (appended) return;
    } else {
      if (appended) out.append(" ");
      out.appendSlice(message, lineStart, trimmedEnd);
      appended = true;
    }
    if (newline < 0) return;
    lineStart = newline + 1;
  }
}

function appendTemplate(
  out: BoundedLogOutput,
  commit: CommitView,
  template: string,
  initialOperations: number,
): number {
  let operations = initialOperations;
  let literalStart = 0;
  for (let index = 0; index < template.length; index++) {
    if (template.charCodeAt(index) !== 0x25) continue;
    operations = nextFormatOperation(operations);
    out.appendSlice(template, literalStart, index);
    const first = template[index + 1]!;
    let token = `%${first}`;
    if (first === "a" || first === "c") token += template[index + 2]!;
    appendTemplateValue(out, commit, token);
    index += token.length - 1;
    literalStart = index + 1;
  }
  operations = nextFormatOperation(operations);
  out.appendSlice(template, literalStart);
  return operations;
}

function nextFormatOperation(current: number): number {
  if (current >= MAX_FORMAT_OPERATIONS) {
    throw new GitError(
      "E2BIG",
      `git CLI log formatting exceeds ${MAX_FORMAT_OPERATIONS} operations`,
    );
  }
  return current + 1;
}

function appendTemplateValue(out: BoundedLogOutput, commit: CommitView, token: string): void {
  if (token === "%H") out.append(commit.oid);
  else if (token === "%h") out.appendSlice(commit.oid, 0, Math.min(7, commit.oid.length));
  else if (token === "%P") {
    for (let index = 0; index < commit.parent.length; index++) {
      if (index > 0) out.append(" ");
      out.append(commit.parent[index]!);
    }
  } else if (token === "%s") appendSubject(out, commit.message);
  else if (token === "%B") out.append(commit.message);
  else if (token === "%an") out.append(commit.author.name);
  else if (token === "%ae") out.append(commit.author.email);
  else if (token === "%at") out.append(String(commit.author.timestamp));
  else if (token === "%cn") out.append(commit.committer.name);
  else if (token === "%ce") out.append(commit.committer.email);
  else if (token === "%ct") out.append(String(commit.committer.timestamp));
  else if (token === "%n") out.append("\n");
  else if (token === "%%") out.append("%");
  else throw new GitError("EINVAL", `unsupported git CLI log placeholder ${token}`);
}

function isTrimWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function utf8RangeBytes(value: string, start: number, end: number): number {
  let bytes = 0;
  for (let index = start; index < end; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff) || index + 1 >= end) {
        throw new GitError("EINVAL", "git CLI log output must be well-formed UTF-16");
      }
      index++;
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new GitError("EINVAL", "git CLI log output must be well-formed UTF-16");
    } else {
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  return bytes;
}
