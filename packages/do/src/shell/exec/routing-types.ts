export interface FileDestination {
  readonly kind: "file";
  readonly path: string;
  readonly append: boolean;
  opened: boolean;
}

export type OutputDestination =
  | { readonly kind: "output" }
  | { readonly kind: "diagnostic" }
  | { readonly kind: "drop" }
  | FileDestination;

export type StdinSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "text"; readonly text: string };

export interface ResolvedRedirections {
  readonly stdin: StdinSource | null;
  readonly output: OutputDestination;
  readonly stdout: OutputDestination;
  readonly stderr: OutputDestination;
  readonly files: readonly FileDestination[];
}

export interface HeldChunk {
  readonly bytes: Uint8Array;
  release(): void;
}
