import { encode } from "../exec/bytes.js";
import { type Command, type CommandResult, result } from "../exec/context.js";

function controlResult(status: number, terminateRun: boolean): CommandResult {
  return {
    ...result((function* () {})(), status),
    control: { kind: "exit", terminateRun },
  };
}

export const exit: Command = (context) => {
  if (!context.mayExitRun) {
    context.warn("only supported as a single-stage pipeline");
    return controlResult(2, false);
  }
  const operand = context.argv[0];
  if (operand === undefined) return controlResult(context.currentStatus, true);
  if (!/^[+-]?[0-9]+$/.test(operand)) {
    context.diagnostic(encode(`bash: line 1: exit: ${operand}: numeric argument required\n`));
    return controlResult(2, true);
  }
  if (context.argv.length > 1) {
    context.diagnostic(encode("bash: line 1: exit: too many arguments\n"));
    return controlResult(1, true);
  }

  const modulus = 256n;
  const status = Number(((BigInt(operand) % modulus) + modulus) % modulus);
  return controlResult(status, true);
};
