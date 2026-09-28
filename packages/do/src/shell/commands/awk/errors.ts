// awk failures. Each maps to one of mawk's diagnostics and exit status 2.

/** A compile-time error: `awk: line N: <message>`, or the message alone without a line. */
export class AwkSyntaxError extends Error {
  constructor(
    readonly line: number | null,
    message: string,
  ) {
    super(message);
    this.name = "AwkSyntaxError";
  }
}

/** A run time error: `awk: run time error: <message>` plus the input position. */
export class AwkRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwkRuntimeError";
  }
}

/** A fatal error mawk reports without position, such as an unreadable input file. */
export class AwkFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwkFatalError";
  }
}
