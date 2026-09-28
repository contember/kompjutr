// Process-environment commands: env, date, sleep, mktemp, sha*sum, base64.

import type { Command } from "../../exec/context.js";
import { base64 } from "./base64.js";
import { checksumCommand } from "./checksum.js";
import { date } from "./date.js";
import { env } from "./env.js";
import { mktemp } from "./mktemp.js";
import { sleep } from "./sleep.js";

export const systemCommands: ReadonlyMap<string, Command> = new Map([
  ["env", env],
  ["date", date],
  ["sleep", sleep],
  ["mktemp", mktemp],
  ["sha1sum", checksumCommand("sha1sum", { digest: "SHA-1", tag: "SHA1" })],
  ["sha256sum", checksumCommand("sha256sum", { digest: "SHA-256", tag: "SHA256" })],
  ["sha512sum", checksumCommand("sha512sum", { digest: "SHA-512", tag: "SHA512" })],
  ["base64", base64],
]);
