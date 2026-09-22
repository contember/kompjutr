import { CorruptError } from "../../common/errors.js";
import { ByteLru } from "../../common/lru.js";
import type { IntegrationSource } from "../../store/operations/integration-workspace/objects.js";
import { integrationPages } from "../../store/operations/integration-workspace/storage.js";
import { candidateOids, validateBlobBatch } from "./integration-content.js";
import type { ContentCandidate } from "./integration-types.js";

const INPUT_CACHE_BYTES = 8 * 1024 * 1024;

export function* integrationInputs(
  source: IntegrationSource,
  candidates: Iterable<ContentCandidate>,
): Generator<{ candidate: ContentCandidate; loaded: ReadonlyMap<string, Uint8Array> }> {
  const cache = new ByteLru<string, Uint8Array>(INPUT_CACHE_BYTES, (data) => data.length);
  try {
    for (const page of integrationPages(candidates)) {
      const requested = new Set<string>();
      for (const candidate of page) for (const oid of candidateOids(candidate)) requested.add(oid);
      const sizes = new Map<string, number>();
      for (const info of source.objectInfo([...requested])) {
        if (info.type !== "blob")
          throw new CorruptError(`integration object ${info.oid} is not a blob`);
        sizes.set(info.oid, info.size);
      }
      let start = 0;
      while (start < page.length) {
        const selected = new Set<string>();
        let size = 0;
        let end = start;
        while (end < page.length) {
          const candidate = page[end]!;
          const additional = new Set(candidateOids(candidate).filter((oid) => !selected.has(oid)));
          let additionalBytes = 0;
          for (const oid of additional) {
            const bytes = sizes.get(oid);
            if (bytes === undefined)
              throw new CorruptError("integration input metadata is incomplete");
            additionalBytes += bytes;
          }
          if (end > start && size + additionalBytes > INPUT_CACHE_BYTES) break;
          for (const oid of additional) selected.add(oid);
          size += additionalBytes;
          end++;
        }
        const loaded = new Map<string, Uint8Array>();
        let missing: string[] = [];
        for (const oid of selected) {
          const bytes = cache.get(oid);
          if (bytes === undefined) missing.push(oid);
          else loaded.set(oid, bytes);
        }
        while (missing.length > 0) {
          const batch = source.readBlobs(missing, { budgetBytes: INPUT_CACHE_BYTES });
          validateBlobBatch(missing, batch.blobs, batch.remaining, batch.bytes);
          for (const [oid, bytes] of batch.blobs) {
            loaded.set(oid, bytes);
            cache.set(oid, bytes);
          }
          missing = batch.remaining;
        }
        for (let index = start; index < end; index++) yield { candidate: page[index]!, loaded };
        start = end;
      }
    }
  } finally {
    cache.clear();
  }
}
