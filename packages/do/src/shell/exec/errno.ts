// The C library's text for filesystem error codes, which coreutils print
// after the operand. An unlisted code keeps the filesystem's own message.

const MESSAGES: ReadonlyMap<string, string> = new Map([
  ["ENOENT", "No such file or directory"],
  ["ENOTDIR", "Not a directory"],
  ["EISDIR", "Is a directory"],
  ["EEXIST", "File exists"],
  ["EACCES", "Permission denied"],
  ["ENOTEMPTY", "Directory not empty"],
  ["ELOOP", "Too many levels of symbolic links"],
]);

export function strerror(error: Error & { readonly code: string }): string {
  return MESSAGES.get(error.code) ?? error.message;
}
