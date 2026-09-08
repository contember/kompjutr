export const utf8: { encode(input?: string): Uint8Array } = new TextEncoder();
export const utf8Decoder: { decode(input?: Uint8Array): string } = new TextDecoder();

export function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));

/**
 * A copy the caller cannot reach. Never `.slice()`: on a `Buffer` — what
 * `node:fs` hands back — that is Node's alias for `subarray()` and returns a
 * view over the caller's memory.
 */
export function ownedBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const ZERO_OID = "0".repeat(40);

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function isAbbreviatedOid(value: string): boolean {
  return /^[0-9a-f]{4,40}$/.test(value);
}
