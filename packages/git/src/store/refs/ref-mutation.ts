import { GitError } from "../../common/errors.js";
import type { RefMutation, RefMutationExpected } from "../core/contracts.js";
import { requireRawRefTarget, requireRefName } from "./ref-validation.js";

export const MAX_REF_MUTATION_INPUTS = 100_000;

export interface NormalizedRefMutation {
  puts: Map<string, string>;
  deletes: Set<string>;
  head: string | undefined;
  expected: RefMutationExpected | undefined;
}

export function normalizeRefMutation(mutation: RefMutation): NormalizedRefMutation {
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  let inputs = 0;
  const countInput = (): void => {
    inputs++;
    if (inputs > MAX_REF_MUTATION_INPUTS) {
      throw new GitError("E2BIG", "ref mutation exceeds its retained input count bound");
    }
  };
  for (const value of mutation.deletes ?? []) {
    const name = requireRefName(value, "deleted ref name", "input");
    countInput();
    deletes.add(name);
  }
  for (const row of mutation.puts ?? []) {
    if (typeof row !== "object" || row === null) {
      throw new GitError("EINVAL", "ref update row is invalid");
    }
    const name = requireRefName(row.name, "updated ref name", "input");
    const target = requireRawRefTarget(row.target, "updated ref target", "input");
    countInput();
    puts.set(name, target);
  }
  const head =
    mutation.head === undefined
      ? undefined
      : requireRawRefTarget(mutation.head, "HEAD target", "input");
  if (head !== undefined) countInput();
  let expected: RefMutationExpected | undefined;
  if (mutation.expected !== undefined) {
    const name = requireRefName(mutation.expected.name, "conditional ref name", "input");
    const target =
      mutation.expected.target === null
        ? null
        : requireRawRefTarget(mutation.expected.target, "expected ref target", "input");
    countInput();
    expected = { name, target };
    if (puts.has(name) === deletes.has(name)) {
      throw new GitError(
        "EINVAL",
        "conditional ref update must include exactly one destination put or delete",
      );
    }
  }
  return { puts, deletes, head, expected };
}
