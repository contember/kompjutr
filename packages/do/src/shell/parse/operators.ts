// The control and redirection operators, shared by the lexer and the word
// scanner: an operator character ends an unquoted word.

export type Operator =
  | "|"
  | "||"
  | "&&"
  | ";"
  | ">"
  | ">>"
  | "<"
  | ">&"
  | "&>"
  | "&>>"
  | "<<"
  | "<<-"
  | "<<<"
  | "("
  | ")";

/** Longest first, so `>>` wins over `>` and `||` over `|`. */
const OPERATORS: ReadonlyArray<Operator | "&"> = [
  "<<<",
  "<<-",
  "&>>",
  "<<",
  ">>",
  ">&",
  "&>",
  "&&",
  "||",
  "|",
  ";",
  ">",
  "<",
  "&",
  "(",
  ")",
];

export function readOperator(
  source: string,
  index: number,
): { value: Operator | "&"; end: number } | null {
  for (const candidate of OPERATORS) {
    if (source.startsWith(candidate, index)) {
      return { value: candidate, end: index + candidate.length };
    }
  }
  return null;
}
