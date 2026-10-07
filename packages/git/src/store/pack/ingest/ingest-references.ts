import { CorruptError } from "../../../common/errors.js";
import {
  type ObjectType,
  parseCommit,
  parseTag,
  TreeParser,
  typeForMode,
} from "../../../common/objects.js";

const OID_WORDS = 5;
const TYPE_MASK = 0b111;
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OBJECT_TYPES: readonly ObjectType[] = ["commit", "tree", "blob", "tag"];
const CODE_TYPE: readonly (ObjectType | undefined)[] = [undefined, "commit", "tree", "blob", "tag"];
const MIN_CAPACITY = 16;
// Load stays at or below 3/4, so linear probe chains stay short.
const MAX_LOAD_NUMERATOR = 3;
const MAX_LOAD_DENOMINATOR = 4;

function expectedBit(type: ObjectType): number {
  return 1 << (TYPE_CODE[type] + 2);
}

/** Callers pass parsed, validated OIDs. */
function hexWord(hex: string, word: number): number {
  return Number.parseInt(hex.slice(word * 8, word * 8 + 8), 16) >>> 0;
}

/** Mix all five OID words with a per-table salt, so crafted OIDs cannot share a probe chain. */
function mixWords(salt: number, keys: Uint32Array, key: number): number {
  let hash = salt;
  for (let word = 0; word < OID_WORDS; word++) {
    hash = Math.imul(hash ^ (keys[key + word] ?? 0), 0x9e3779b1);
    hash ^= hash >>> 15;
  }
  hash = Math.imul(hash ^ (hash >>> 13), 0x85ebca77);
  return (hash ^ (hash >>> 16)) >>> 0;
}

function wordHex(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function capacityFor(entries: number): number {
  let capacity = MIN_CAPACITY;
  while (capacity * MAX_LOAD_NUMERATOR < entries * MAX_LOAD_DENOMINATOR) capacity *= 2;
  return capacity;
}

/** A referenced object no pack of the operation delivered, with every type it was expected as. */
export interface UnresolvedReference {
  oid: string;
  expected: readonly ObjectType[];
}

/**
 * The object IDs a pack holds and the ones its objects reference (ADR-0029).
 * Each slot keys a 20-byte OID in an open-addressing table and keeps the
 * in-pack type plus the set of types references expect; edges are not kept.
 */
export class PackReferenceCollector {
  #keys: Uint32Array;
  #states: Uint8Array;
  #mask: number;
  #size = 0;
  #longestProbe = 0;
  readonly #salt = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  readonly #probe = new Uint32Array(OID_WORDS);
  readonly #boundary: ReadonlySet<string>;

  /** `boundary` commits contribute their tree, never their parents. */
  constructor(objectCount: number, boundary: ReadonlySet<string>) {
    const capacity = capacityFor(objectCount);
    this.#keys = new Uint32Array(capacity * OID_WORDS);
    this.#states = new Uint8Array(capacity);
    this.#mask = capacity - 1;
    this.#boundary = boundary;
  }

  /** The most slots one lookup has visited, a witness that probe chains stay short. */
  get longestProbe(): number {
    return this.#longestProbe;
  }

  /** Record one resolved pack object; its references are added separately. */
  addObject(oid: string, type: ObjectType): void {
    const slot = this.#slot(oid);
    const state = this.#states[slot] ?? 0;
    const held = state & TYPE_MASK;
    if (held !== 0 && held !== TYPE_CODE[type]) {
      throw new CorruptError(`pack holds ${oid} as two object types`);
    }
    this.#states[slot] = state | TYPE_CODE[type];
  }

  /** A commit references its tree and, outside the shallow boundary, its parents. */
  addCommit(oid: string, data: Uint8Array): void {
    const commit = parseCommit(data);
    this.#expect(commit.tree, "tree");
    if (this.#boundary.has(oid)) return;
    for (const parent of commit.parent) this.#expect(parent, "commit");
  }

  addTag(data: Uint8Array): void {
    const tag = parseTag(data);
    this.#expect(tag.object, tag.type);
  }

  /** A tree references its entries by mode; a gitlink is not checked. */
  addTree(chunks: Iterable<Uint8Array>): void {
    const parser = new TreeParser();
    try {
      for (const chunk of chunks) {
        for (const parsed of parser.push(chunk)) {
          const type = typeForMode(parsed.entry.mode);
          if (type !== "commit") this.#expect(parsed.entry.oid, type);
        }
      }
      parser.finish();
    } finally {
      parser.dispose();
    }
  }

  /** Throw `CorruptError` when a reference expects another type than the object has. */
  requireTypes(): void {
    for (let slot = 0; slot < this.#states.length; slot++) {
      const state = this.#states[slot] ?? 0;
      const held = state & TYPE_MASK;
      const expected = state >>> 3;
      if (expected === 0) continue;
      const type = CODE_TYPE[held];
      const conflicting =
        type === undefined ? expected & (expected - 1) : state & ~(expectedBit(type) | TYPE_MASK);
      if (conflicting !== 0) {
        const wanted = this.#expectedTypes(state).find((candidate) => candidate !== type);
        throw new CorruptError(
          `fetched graph requires ${this.#oidAt(slot)} to be a ${wanted ?? "different object"}`,
        );
      }
    }
  }

  /** References the pack itself does not resolve, in slot order. */
  *unresolved(): Generator<UnresolvedReference> {
    for (let slot = 0; slot < this.#states.length; slot++) {
      const state = this.#states[slot] ?? 0;
      if (state === 0 || (state & TYPE_MASK) !== 0) continue;
      yield { oid: this.#oidAt(slot), expected: this.#expectedTypes(state) };
    }
  }

  #expect(oid: string, type: ObjectType): void {
    const slot = this.#slot(oid);
    this.#states[slot] = (this.#states[slot] ?? 0) | expectedBit(type);
  }

  #expectedTypes(state: number): ObjectType[] {
    const types: ObjectType[] = [];
    for (const type of OBJECT_TYPES) {
      if ((state & expectedBit(type)) !== 0) types.push(type);
    }
    return types;
  }

  /** The slot holding `oid`, claimed when absent. */
  #slot(oid: string): number {
    if ((this.#size + 1) * MAX_LOAD_DENOMINATOR > this.#states.length * MAX_LOAD_NUMERATOR) {
      this.#grow();
    }
    const probe = this.#probe;
    for (let word = 0; word < OID_WORDS; word++) probe[word] = hexWord(oid, word);
    let slot = mixWords(this.#salt, probe, 0) & this.#mask;
    for (let visited = 1; ; visited++) {
      if (visited > this.#longestProbe) this.#longestProbe = visited;
      const key = slot * OID_WORDS;
      if (this.#states[slot] === 0) {
        this.#keys.set(probe, key);
        this.#size++;
        return slot;
      }
      if (
        this.#keys[key] === probe[0] &&
        this.#keys[key + 1] === probe[1] &&
        this.#keys[key + 2] === probe[2] &&
        this.#keys[key + 3] === probe[3] &&
        this.#keys[key + 4] === probe[4]
      ) {
        return slot;
      }
      slot = (slot + 1) & this.#mask;
    }
  }

  #grow(): void {
    const keys = this.#keys;
    const states = this.#states;
    const capacity = states.length * 2;
    this.#keys = new Uint32Array(capacity * OID_WORDS);
    this.#states = new Uint8Array(capacity);
    this.#mask = capacity - 1;
    for (let from = 0; from < states.length; from++) {
      const state = states[from] ?? 0;
      if (state === 0) continue;
      const source = from * OID_WORDS;
      let slot = mixWords(this.#salt, keys, source) & this.#mask;
      while (this.#states[slot] !== 0) slot = (slot + 1) & this.#mask;
      this.#keys.set(keys.subarray(source, source + OID_WORDS), slot * OID_WORDS);
      this.#states[slot] = state;
    }
  }

  #oidAt(slot: number): string {
    const key = slot * OID_WORDS;
    let hex = "";
    for (let word = 0; word < OID_WORDS; word++) hex += wordHex(this.#keys[key + word] ?? 0);
    return hex;
  }
}
