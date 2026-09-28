// awk text is bytes. Strings here hold one UTF-16 unit per byte (latin1), so
// every string operation counts and compares bytes, as mawk does in the C locale.

const CHUNK = 8192;

export function bytesToText(bytes: Uint8Array): string {
  let text = "";
  for (let start = 0; start < bytes.length; start += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return text;
}

export function textToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return bytes;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** A JS string from the shell (argv, env) as awk bytes. */
export function fromUnicode(text: string): string {
  return bytesToText(ENCODER.encode(text));
}

/** awk bytes back to a JS string, for filesystem paths. */
export function toUnicode(text: string): string {
  return DECODER.decode(textToBytes(text));
}
