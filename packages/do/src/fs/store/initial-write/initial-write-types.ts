export interface InitialWriteOptions {
  mode?: number;
  contentId?: Uint8Array;
}

export interface InitialSymlinkOptions {
  mode?: number;
  contentId?: Uint8Array;
}

export interface InitialWorktreeSession {
  writeSymlink(path: string, target: string, options?: InitialSymlinkOptions): void;
  writeFile(path: string, bytes: Uint8Array, options?: InitialWriteOptions): void;
  writeFileStream(
    path: string,
    size: number,
    chunks: Iterable<Uint8Array>,
    options?: InitialWriteOptions,
  ): void;
}

export type InitialWriteResult<T> = { kind: "committed"; value: T } | { kind: "unavailable" };
