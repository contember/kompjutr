// Bounded `printf`: literals are streamed through the executor's stdout sink.

import { type ByteStream, encode } from "../exec/bytes.js";
import type { Command, CommandResult } from "../exec/context.js";
import { UsageError } from "./flags.js";

type FormatToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "string" }
  | { readonly kind: "decimal" }
  | { readonly kind: "invalid"; readonly conversion: string };

export const printf: Command = (context) => {
  const format = context.argv[0];
  if (format === undefined) throw new UsageError("usage: printf FORMAT [ARGUMENT]...");

  const tokens = parseFormat(format);
  const operands = context.argv.slice(1);
  let status = 0;
  const stdout = render(tokens, operands, context.warn, () => {
    status = 1;
  });
  const result: CommandResult = {
    stdout,
    status: () => status,
    truncated: () => false,
  };
  return result;
};

function* render(
  tokens: readonly FormatToken[],
  operands: readonly string[],
  warn: (message: string) => void,
  fail: () => void,
): ByteStream {
  const consumesOperands = tokens.some(
    (token) => token.kind === "string" || token.kind === "decimal",
  );
  let operandIndex = 0;

  do {
    for (const token of tokens) {
      if (token.kind === "literal") {
        if (token.value !== "") yield encode(token.value);
        continue;
      }
      if (token.kind === "invalid") {
        warn(`\`${token.conversion}': invalid format character`);
        fail();
        return;
      }

      const operand = operands[operandIndex];
      if (operand !== undefined) operandIndex++;
      if (token.kind === "string") {
        if (operand !== undefined && operand !== "") yield encode(operand);
        continue;
      }
      yield encode(operand === undefined ? "0" : decimal(operand));
    }
  } while (consumesOperands && operandIndex < operands.length);
}

function parseFormat(format: string): FormatToken[] {
  const tokens: FormatToken[] = [];
  let literal = "";

  const flushLiteral = (): void => {
    if (literal === "") return;
    tokens.push({ kind: "literal", value: literal });
    literal = "";
  };

  for (let index = 0; index < format.length; index++) {
    const char = format.charAt(index);
    if (char === "\\") {
      const escaped = format.charAt(index + 1);
      const value = escapeValue(escaped);
      if (value === null) {
        const spelling = escaped === "" ? "trailing backslash" : `escape \\${escaped}`;
        throw new UsageError(`${spelling} is not supported`);
      }
      literal += value;
      index++;
      continue;
    }
    if (char !== "%") {
      literal += char;
      continue;
    }

    flushLiteral();
    const conversion = format.charAt(index + 1);
    if (conversion === "%") {
      literal += "%";
      index++;
      continue;
    }
    if (conversion === "s") tokens.push({ kind: "string" });
    else if (conversion === "d") tokens.push({ kind: "decimal" });
    else if (conversion === "b" || conversion === "q" || conversion === "c") {
      throw new UsageError(`%${conversion} is not supported`);
    } else if (isFormatModifier(conversion)) {
      throw new UsageError("format width and precision are not supported");
    } else {
      tokens.push({ kind: "invalid", conversion });
    }
    index++;
  }

  flushLiteral();
  return tokens;
}

function escapeValue(escaped: string): string | null {
  if (escaped === "n") return "\n";
  if (escaped === "t") return "\t";
  if (escaped === "r") return "\r";
  if (escaped === "\\") return "\\";
  if (escaped === "0") return "\0";
  return null;
}

function isFormatModifier(char: string): boolean {
  return (
    char === "." ||
    char === "*" ||
    char === "-" ||
    char === "+" ||
    char === " " ||
    /^[0-9]$/.test(char)
  );
}

function decimal(value: string): string {
  if (!/^[+-]?(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new UsageError(`numeric operand '${value}' is not a signed decimal`);
  }
  const negative = value.startsWith("-");
  const unsigned = value.startsWith("-") || value.startsWith("+") ? value.slice(1) : value;
  return negative && unsigned !== "0" ? `-${unsigned}` : unsigned;
}
