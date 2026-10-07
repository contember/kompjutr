// Miniflare entry for the ADR-0030 interleaving scenario; bundled by the test.

import { Database, type DurableObjectStorageLike } from "../../packages/do/src/db/db.js";
import { ClosureFaultDatabase, runInterleaving } from "./projection-interleaving.js";

interface Input {
  pack: string;
  refs: { name: string; target: string }[];
  theirs: string;
  dirty: { path: string; text: string };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`invalid ${label}`);
  return value;
}

/** The scenario input the test posts; the worker trusts nothing it did not check. */
function parseInput(value: unknown): Input {
  if (typeof value !== "object" || value === null) throw new Error("invalid input");
  const refs = Reflect.get(value, "refs");
  const dirty = Reflect.get(value, "dirty");
  if (!Array.isArray(refs) || typeof dirty !== "object" || dirty === null) {
    throw new Error("invalid input");
  }
  return {
    pack: text(Reflect.get(value, "pack"), "pack"),
    refs: refs.map((ref: unknown) => {
      if (typeof ref !== "object" || ref === null) throw new Error("invalid ref");
      return {
        name: text(Reflect.get(ref, "name"), "ref name"),
        target: text(Reflect.get(ref, "target"), "ref target"),
      };
    }),
    theirs: text(Reflect.get(value, "theirs"), "theirs"),
    dirty: {
      path: text(Reflect.get(dirty, "path"), "dirty path"),
      text: text(Reflect.get(dirty, "text"), "dirty text"),
    },
  };
}

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

export class InterleavingProbe {
  readonly #storage: DurableObjectStorageLike;

  constructor(state: { storage: DurableObjectStorageLike }) {
    this.#storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const input = parseInput(await request.json());
    const result = await runInterleaving(new ClosureFaultDatabase(new Database(this.#storage)), {
      ...input,
      pack: decodeBase64(input.pack),
    });
    return Response.json(result);
  }
}

export default {
  fetch(
    request: Request,
    env: {
      PROBE: {
        idFromName(name: string): unknown;
        get(id: unknown): { fetch(request: Request): Promise<Response> };
      };
    },
  ): Promise<Response> {
    return env.PROBE.get(env.PROBE.idFromName("probe")).fetch(request);
  },
};
