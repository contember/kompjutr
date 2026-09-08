export type FilesystemErrorCode =
  | "ENOENT"
  | "ENOTEMPTY"
  | "ENOTDIR"
  | "EISDIR"
  | "EEXIST"
  | "EINVAL"
  | "EACCES"
  | "EPERM"
  | "EROFS"
  | "ENOSYS"
  | "EBADF"
  | "ELOOP"
  | "EIO";

/** The node:fs error fields consumers inspect. */
export class FilesystemError extends Error {
  readonly code: FilesystemErrorCode;
  readonly path: string | undefined;
  readonly syscall: string | undefined;

  constructor(
    code: FilesystemErrorCode,
    message: string,
    options: { path?: string; syscall?: string } = {},
  ) {
    super(message);
    this.name = "FilesystemError";
    this.code = code;
    this.path = options.path;
    this.syscall = options.syscall;
  }
}

export function filesystemError(
  code: FilesystemErrorCode,
  syscall: string,
  path?: string,
  detail?: string,
): FilesystemError {
  const suffix = path === undefined ? "" : `, '${path}'`;
  return new FilesystemError(code, `${code}: ${detail ?? code}, ${syscall}${suffix}`, {
    path,
    syscall,
  });
}
