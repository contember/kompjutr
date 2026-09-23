import { CorruptError } from "../../../common/errors.js";
import type { ExpectedPackMembership } from "../shared.js";

/**
 * Delta chain depth of every indexed entry, by physical ordinal. A delta is
 * indexed only after its in-pack base, so the base depth is always known.
 */
export class PackDeltaDepths {
  readonly #depths: Uint32Array;

  constructor(
    private readonly membership: ExpectedPackMembership,
    private readonly maxDeltaDepth: number,
  ) {
    this.#depths = new Uint32Array(membership.count);
  }

  record(offset: number, baseOffset: number | null): void {
    const depth =
      baseOffset === null ? 0 : this.#depths[this.membership.ordinalOf(baseOffset)]! + 1;
    if (depth > this.maxDeltaDepth) {
      throw new CorruptError(
        `delta chain deeper than ${this.maxDeltaDepth} at pack offset ${offset}`,
      );
    }
    this.#depths[this.membership.ordinalOf(offset)] = depth;
  }
}
