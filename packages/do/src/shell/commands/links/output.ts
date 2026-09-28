// Output and diagnostic spelling shared by the family.
//
// Every command here mutates or resolves eagerly and only then publishes its
// stdout, so a consumer that never reads (`ln -sv a b | echo`) cannot leave
// a link uncreated. The held lines are reserved on the retained budget.

import { type ByteStream, encode, owned } from "../../exec/bytes.js";
import type { CommandContext, CommandResult } from "../../exec/context.js";

export class HeldOutput {
  readonly #chunks: Uint8Array[] = [];
  readonly #releases: Array<() => void> = [];

  constructor(private readonly context: CommandContext) {}

  write(text: string): void {
    const bytes = encode(text);
    this.#releases.push(this.context.fs.retained.retain(bytes.length, "link command output"));
    this.#chunks.push(bytes);
  }

  result(status: number): CommandResult {
    const chunks = this.#chunks;
    const releases = this.#releases;
    const stream = owned(
      (function* (): ByteStream {
        yield* chunks;
      })(),
      () => {
        for (const release of releases) release();
      },
    );
    return { stdout: stream, status: () => status, truncated: () => false };
  }
}

/**
 * The quoting coreutils and uucore apply to a name in a message: single
 * quotes, or double quotes when the name holds a single quote and nothing
 * double quotes would expand.
 */
export function quote(name: string): string {
  if (!name.includes("'")) return `'${name}'`;
  if (!/["$`\\]/.test(name)) return `"${name}"`;
  return `'${name.replaceAll("'", "'\\''")}'`;
}

/** uucore's text for an I/O error kind, which differs from `strerror` for some codes. */
const KIND_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["ENOENT", "No such file or directory"],
  ["EEXIST", "Already exists"],
  ["ENOTDIR", "Not a directory"],
  ["EISDIR", "Is a directory"],
  ["EPERM", "Permission denied"],
  ["EACCES", "Permission denied"],
  ["ENOTEMPTY", "Directory not empty"],
  ["ELOOP", "Too many levels of symbolic links"],
  ["EINVAL", "Invalid input"],
]);

export function kindMessage(error: Error & { readonly code: string }): string {
  return KIND_MESSAGES.get(error.code) ?? error.message;
}
