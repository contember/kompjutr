export interface InitialWriteOptions {
  mode?: number;
  contentId?: Uint8Array;
}

export interface InitialSymlinkOptions {
  mode?: number;
  contentId?: Uint8Array;
}

/** What `stat` reports for the written entry once the session commits. */
export interface InitialWriteStat {
  ino: number;
  mtime: number;
  rev: number;
}

export interface InitialWorktreeSession {
  writeSymlink(path: string, target: string, options?: InitialSymlinkOptions): InitialWriteStat;
  writeFile(path: string, bytes: Uint8Array, options?: InitialWriteOptions): InitialWriteStat;
  writeFileStream(
    path: string,
    size: number,
    chunks: Iterable<Uint8Array>,
    options?: InitialWriteOptions,
  ): InitialWriteStat;
}

export type InitialWriteResult<T> = { kind: "committed"; value: T } | { kind: "unavailable" };
