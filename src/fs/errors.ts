/** Build filesystem errors with stable `code` and optional `path` fields. */
export function filesystemError(code: string, message: string, path?: string): Error {
  const text = path === undefined ? message : `${code}: ${message}, '${path}'`;
  return path === undefined
    ? Object.assign(new Error(text), { code })
    : Object.assign(new Error(text), { code, path });
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
