import { encode, firstNul } from "../../exec/bytes.js";
import type { BoundedFs } from "../../exec/context.js";
import { compileRecordPattern } from "./regex.js";
import type { SearchRequest } from "./search.js";
import { matchGroups } from "./search-matches.js";
import { renderLine } from "./search-output.js";
import { jsonText, searchText, withoutBom } from "./search-text.js";

export interface JsonStats {
  searches: number;
  searches_with_match: number;
  bytes_searched: number;
  bytes_printed: number;
  matched_lines: number;
  matches: number;
  duration: number;
}

export function newJsonStats(): JsonStats {
  return {
    searches: 0,
    searches_with_match: 0,
    bytes_searched: 0,
    bytes_printed: 0,
    matched_lines: 0,
    matches: 0,
    duration: 0,
  };
}

function elapsed(milliseconds: number) {
  const secs = Math.floor(milliseconds / 1_000);
  const nanos = Math.floor((milliseconds - secs * 1_000) * 1_000_000);
  return { secs, nanos, human: `${(milliseconds / 1_000).toFixed(6)}s` };
}

function wireStats(stats: JsonStats) {
  const { duration, ...counts } = stats;
  return { elapsed: elapsed(duration), ...counts };
}

export function jsonSummary(stats: JsonStats, duration: number): Uint8Array {
  return encode(
    `${JSON.stringify({ type: "summary", data: { elapsed_total: elapsed(duration), stats: wireStats(stats) } })}\n`,
  );
}

export async function* emitRecords(
  path: string,
  bytes: Uint8Array,
  request: SearchRequest,
  withFilename: boolean,
  noteMatch: () => void,
  retained: BoundedFs["retained"],
  totals: JsonStats,
): AsyncGenerator<Uint8Array> {
  const content = withoutBom(bytes);
  const compiled = compileRecordPattern(request.pattern, request.multiline ?? false);
  const input = searchText(content, retained);
  const nul = firstNul(content);
  const binaryOffset = nul < 0 ? null : nul;
  const started = performance.now();
  const stats = newJsonStats();
  let began = false;
  let count = 0;
  let capped = false;
  try {
    for (const group of matchGroups(input, content, compiled, retained)) {
      noteMatch();
      count++;
      const selected = content.subarray(group.start, group.end);
      stats.searches = 1;
      stats.matches += group.submatches.length;
      let lineCount = selected[selected.length - 1] === 10 ? 0 : 1;
      for (const byte of selected) if (byte === 10) lineCount++;
      stats.matched_lines += lineCount;
      stats.searches_with_match = 1;
      if (!request.json && binaryOffset !== null && request.mode === "content") {
        const notice = request.reportBinary(path, binaryOffset, withFilename);
        if (notice !== null) yield notice;
        return;
      }
      if (request.mode === "files") {
        yield encode(`${path}\n`);
        return;
      }
      if (request.json) {
        if (!began) {
          const begin = encode(
            `${JSON.stringify({ type: "begin", data: { path: { text: path } } })}\n`,
          );
          stats.bytes_printed += begin.length;
          yield begin;
          began = true;
        }
        const record = encode(
          `${JSON.stringify({
            type: "match",
            data: {
              path: { text: path },
              lines: jsonText(selected),
              line_number: group.line,
              absolute_offset: group.start,
              submatches: group.submatches,
            },
          })}\n`,
        );
        stats.bytes_printed += record.length;
        yield record;
      } else if (request.mode !== "count") {
        let start = 0;
        let line = group.line;
        while (start < selected.length) {
          const newline = selected.indexOf(10, start);
          const end = newline < 0 ? selected.length : newline;
          yield renderLine(
            { name: path, number: line++, withFilename, lineNumbers: request.lineNumbers },
            selected.subarray(start, end),
            true,
          );
          start = end + 1;
        }
      }
      if (request.maxCount !== undefined && count >= request.maxCount) {
        capped = true;
        break;
      }
    }
    if (request.mode === "count" && stats.matches > 0) {
      yield encode(
        `${withFilename ? `${path}:` : ""}${compiled.multiline ? stats.matches : count}\n`,
      );
    }
    if (stats.searches > 0)
      stats.bytes_searched = binaryOffset ?? (!compiled.multiline && capped ? 0 : content.length);
    stats.duration = performance.now() - started;
    if (began)
      yield encode(
        `${JSON.stringify({ type: "end", data: { path: { text: path }, binary_offset: binaryOffset, stats: wireStats(stats) } })}\n`,
      );
  } finally {
    totals.searches += stats.searches;
    totals.searches_with_match += stats.searches_with_match;
    totals.bytes_searched += stats.bytes_searched;
    totals.bytes_printed += stats.bytes_printed;
    totals.matched_lines += stats.matched_lines;
    totals.matches += stats.matches;
    totals.duration += stats.duration;
    input.release();
  }
}
