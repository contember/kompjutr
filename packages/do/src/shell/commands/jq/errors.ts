// Three ways a jq program stops. A JqError is jq's own runtime error: `try`
// catches it and its value becomes the message. A JqRefusal is this shell
// declining a form jq would run; nothing catches it and the command exits 2.
// A CompileError carries jq's compile diagnostics and exits 3.

import { truncatedDump } from "./dump.js";
import { type JqValue, kindOf } from "./value.js";

export class JqError extends Error {
  constructor(readonly value: JqValue) {
    super(typeof value === "string" ? value : "jq error");
    this.name = "JqError";
  }
}

export class JqRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JqRefusal";
  }
}

export class CompileError extends Error {
  constructor(
    readonly diagnostics: readonly string[],
    readonly status = 3,
  ) {
    super(diagnostics.join("\n"));
    this.name = "CompileError";
  }
}

/** `kind (value) message`, as jq's type_error writes it. */
export function typeError(value: JqValue, message: string): JqError {
  return new JqError(`${kindOf(value)} (${truncatedDump(value)}) ${message}`);
}

export function typeError2(left: JqValue, right: JqValue, message: string): JqError {
  return new JqError(
    `${kindOf(left)} (${truncatedDump(left)}) and ${kindOf(right)} (${truncatedDump(right)}) ${message}`,
  );
}
