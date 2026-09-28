// `sha*sum -c`: read checksum lines and verify each listed file. The line
// grammar and the summary warnings are uutils 0.2.2's, quirks included: an
// even-length hex digest of any length is well formed (and then simply fails
// to match), `--status` still reports a listed file it could not open, a line
// with a leading backslash is malformed, and `\\` and `\n` in any name are
// unescaped.

import { type ByteStream, decode, empty, encode, lines } from "../../exec/bytes.js";
import type { CommandContext } from "../../exec/context.js";
import { streamFile } from "../read.js";
import { type Algorithm, digestInput, openInput, type Verbosity } from "./digest.js";
import { maybeQuote } from "./quote.js";

export interface CheckOptions {
  readonly verbosity: Verbosity;
  readonly strict: boolean;
  readonly ignoreMissing: boolean;
}

interface CheckLine {
  readonly digest: string;
  readonly name: string;
  /** The name as the OK and FAILED lines print it: an unescaped name is re-marked. */
  readonly shown: string;
}

const FAILED = 1;
const UNTAGGED = /^([0-9a-fA-F]+) [ *]?(.*)$/;

export async function* verify(
  context: CommandContext,
  algorithm: Algorithm,
  checkFiles: readonly string[],
  options: CheckOptions,
  setStatus: (status: number) => void,
): ByteStream {
  const tagged = new RegExp(`^${algorithm.tag} \\((.*)\\) = ([0-9a-fA-F]+)$`);
  for (const checkFile of checkFiles) {
    const input = openInput(context, checkFile);
    if (input.kind === "missing" || input.kind === "directory") {
      const problem = input.kind === "missing" ? "No such file or directory" : "Is a directory";
      context.warn(`${checkFile}: ${problem}`);
      setStatus(FAILED);
      continue;
    }
    const source =
      input.kind === "stdin"
        ? (context.stdin ?? empty())
        : streamFile(context, input.path, input.size, "checksum list");

    let lineNumber = 0;
    let improper = 0;
    let proper = 0;
    let mismatched = 0;
    let unread = 0;
    let verified = 0;
    for await (const bytes of lines(source, context.fs.retained)) {
      lineNumber++;
      const parsed = parseLine(decode(bytes), tagged);
      if (parsed === null) {
        improper++;
        if (options.verbosity === "warn") {
          context.warn(
            `${checkFile}: ${lineNumber}: improperly formatted ${algorithm.tag} checksum line`,
          );
        }
        continue;
      }
      proper++;

      const listed = openInput(context, parsed.name);
      if (listed.kind === "missing" && options.ignoreMissing) continue;
      if (listed.kind === "missing" || listed.kind === "directory") {
        const problem = listed.kind === "missing" ? "No such file or directory" : "Is a directory";
        context.warn(`${maybeQuote(parsed.name)}: ${problem}`);
        unread++;
        yield encode(`${parsed.name}: FAILED open or read\n`);
        continue;
      }
      const digest = await digestInput(context, algorithm, listed);
      verified++;
      if (digest === parsed.digest) {
        if (options.verbosity === "normal" || options.verbosity === "warn") {
          yield encode(`${parsed.shown}: OK\n`);
        }
      } else {
        mismatched++;
        if (options.verbosity !== "status") yield encode(`${parsed.shown}: FAILED\n`);
      }
    }

    if (proper === 0) {
      const shown = maybeQuote(input.kind === "stdin" ? "standard input" : checkFile);
      context.warn(`${shown}: no properly formatted checksum lines found`);
      setStatus(FAILED);
      continue;
    }
    if (options.verbosity !== "status") {
      if (improper > 0) {
        context.warn(
          `WARNING: ${improper} ${improper === 1 ? "line is" : "lines are"} improperly formatted`,
        );
      }
      if (mismatched > 0) {
        context.warn(
          `WARNING: ${mismatched} computed ${plural(mismatched, "checksum")} did NOT match`,
        );
      }
      if (unread > 0) {
        context.warn(`WARNING: ${unread} listed ${plural(unread, "file")} could not be read`);
      }
    }
    if (options.ignoreMissing && verified === 0) {
      context.warn(`${maybeQuote(checkFile)}: no file was verified`);
      setStatus(FAILED);
    }
    if (mismatched > 0 || unread > 0 || (options.strict && improper > 0)) setStatus(FAILED);
  }
}

function parseLine(text: string, tagged: RegExp): CheckLine | null {
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  let digest: string;
  let written: string;
  const tag = tagged.exec(line);
  const untagged = tag === null ? UNTAGGED.exec(line) : null;
  if (tag !== null) {
    [, written = "", digest = ""] = tag;
  } else if (untagged !== null) {
    [, digest = "", written = ""] = untagged;
  } else {
    return null;
  }
  if (digest.length % 2 !== 0 || written === "") return null;
  const name = unescapeName(written);
  return { digest, name, shown: name === written ? written : `\\${written}` };
}

/** `\\` and `\n` are escapes; any other backslash is literal. */
function unescapeName(written: string): string {
  let name = "";
  for (let index = 0; index < written.length; index++) {
    const char = written.charAt(index);
    const next = written.charAt(index + 1);
    if (char === "\\" && (next === "\\" || next === "n")) {
      name += next === "n" ? "\n" : "\\";
      index++;
      continue;
    }
    name += char;
  }
  return name;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
