import type { GcEvent, GcTrace } from "../workerd/gc-trace.js";

export function serverGcMetrics(trace: GcTrace, marker: number, boundaries: readonly GcEvent[]) {
  try {
    return { lowerBound: true, ...trace.attributeBetweenMarkers(marker - 1, marker) };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "the measured region holds no unforced GC event"
    )
      throw error;
    const first = boundaries[marker - 2];
    const last = boundaries[marker - 1];
    if (
      first === undefined ||
      last === undefined ||
      first.isolate !== last.isolate ||
      last.externalAfterBytes === null ||
      last.arrayBufferAfterBytes === null
    )
      throw new Error("GC boundary samples are incomplete");
    return {
      lowerBound: true,
      boundaryOnly: true,
      gcEvents: 0,
      samples: 1,
      note: "No organic GC occurred. Only the closing forced GC samples the phase; this is not a peak upper bound.",
      peakUsedPlusExternalBytes: last.usedBeforeBytes + last.externalAfterBytes,
      closingHeapUsedBytes: last.usedAfterBytes,
      closingExternalBytes: last.externalAfterBytes,
      closingArrayBufferBytes: last.arrayBufferAfterBytes,
    };
  }
}
