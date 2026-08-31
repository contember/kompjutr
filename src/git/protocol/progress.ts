// Git reports progress as free text on side-band 2. Computer's interface
// wants it two ways: `onMessage` gets the line as the remote wrote it,
// `onProgress` gets a structured event. Parsing the line is the only way
// to have both, and is what isomorphic-git does too.

export interface ProgressEvent {
  phase: string;
  loaded: number;
  total?: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;
export type MessageCallback = (message: string) => void;

// "Receiving objects:  42% (100/238), 1.2 MiB | 500 KiB/s" and friends.
// The counted form is the only one worth reporting; "…, done." carries no
// new number.
const COUNTED = /^([A-Za-z][A-Za-z ]*):\s+(?:\d+%\s+)?\((\d+)\/(\d+)\)/;
const BARE = /^([A-Za-z][A-Za-z ]*):\s+(\d+)(?:\s|,|$)/;

export function parseProgress(line: string): ProgressEvent | null {
  const trimmed = line.trim();
  const counted = COUNTED.exec(trimmed);
  if (counted !== null) {
    return {
      phase: counted[1]!,
      loaded: Number.parseInt(counted[2]!, 10),
      total: Number.parseInt(counted[3]!, 10),
    };
  }
  const bare = BARE.exec(trimmed);
  if (bare !== null) return { phase: bare[1]!, loaded: Number.parseInt(bare[2]!, 10) };
  return null;
}

/**
 * One text sink that feeds both callbacks. A remote can pack several
 * newline- or carriage-return-separated updates into one side-band frame,
 * so each is reported separately.
 */
export function progressSink(
  onProgress: ProgressCallback | undefined,
  onMessage: MessageCallback | undefined,
): ((text: string) => void) | undefined {
  if (onProgress === undefined && onMessage === undefined) return undefined;
  return (text: string): void => {
    onMessage?.(text);
    if (onProgress === undefined) return;
    for (const line of text.split(/[\r\n]+/)) {
      if (line === "") continue;
      const event = parseProgress(line);
      if (event !== null) onProgress(event);
    }
  };
}
