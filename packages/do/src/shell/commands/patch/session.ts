// The state GNU patch keeps across one patch in the input: which way it is
// applied, whether the rest of it is being skipped, and which file it reads.
// Questions are answered as GNU answers them without a terminal: the prompt
// is printed and the default is taken.

import type { Stat } from "../../../fs/types.js";
import type { Transcript } from "./messages.js";
import type { PatchOptions } from "./options.js";
import type { Publisher } from "./publish.js";

export class Session {
  reverse: boolean;
  skipRest = false;
  /** The file to read, once chosen. */
  inname: string | null;
  /** Its status; null when it does not exist. */
  inStat: Stat | null = null;

  constructor(
    readonly options: PatchOptions,
    readonly publisher: Publisher,
    private readonly transcript: Transcript,
  ) {
    this.reverse = options.reverse;
    this.inname = options.target;
  }

  /** GNU's `reinitialize_almost_everything`, before each patch. */
  reset(): void {
    this.reverse = this.options.reverse;
    this.skipRest = false;
    this.inname = this.options.target;
    this.inStat = null;
  }

  say(text: string | Uint8Array): void {
    this.transcript.say(text);
  }

  /** Print a question and take its default answer. */
  ask(prompt: string): void {
    this.say(`${prompt}\n`);
  }

  /** GNU's `ok_to_reverse`: true when the patch should now be applied the other way. */
  okToReverse(message: string): boolean {
    const { forward, force, batch, silent } = this.options;
    if (forward || !(force && silent)) this.say(message);
    if (forward) {
      this.say("  Skipping patch.\n");
      this.skipRest = true;
      return false;
    }
    if (force) {
      if (!silent) this.say("  Applying it anyway.\n");
      return false;
    }
    if (batch) {
      this.say(this.reverse ? "  Ignoring -R.\n" : "  Assuming -R.\n");
      return true;
    }
    this.ask(this.reverse ? "  Ignore -R? [n] " : "  Assume -R? [n] ");
    this.ask("Apply anyway? [n] ");
    if (!silent) this.say("Skipping patch.\n");
    this.skipRest = true;
    return false;
  }
}
