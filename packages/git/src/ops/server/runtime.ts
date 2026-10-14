export interface ServerRuntime {
  readonly now: () => number;
  readonly yieldNow: () => Promise<void>;
  readonly signal: AbortSignal;
}

export interface GitServerOptions {
  /** Maximum raw incoming pack bytes the deployment is prepared to store. */
  readonly maxPackBytes: number;
  readonly receivePack?: boolean;
  readonly now?: () => number;
  readonly yieldNow?: () => Promise<void>;
}
