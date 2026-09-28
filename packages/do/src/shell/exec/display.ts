// Paths as a command prints them. GNU find, grep, and rg show a result under
// an operand as the operand exactly as typed plus the rest of the path, so
// `find .` prints `./a` and `grep -r x src/` prints `src/a`. An empty operand
// is rg's implicit working directory, which prints the bare relative path.

/** `path` lies at or under `operandPath`, the resolved form of `operand`. */
export function displayUnder(operand: string, operandPath: string, path: string): string {
  if (path === operandPath) return operand;
  const rest = path.slice(operandPath === "/" ? 1 : operandPath.length + 1);
  if (operand === "") return rest;
  return operand.endsWith("/") ? `${operand}${rest}` : `${operand}/${rest}`;
}
