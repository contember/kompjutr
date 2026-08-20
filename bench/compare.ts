// Render a sweep's JSON as the side-by-side table the reference report uses:
// one row per operation, both clients, and the ratio between them.

import { readFileSync } from "node:fs";

interface Row {
  status: string;
  operation?: string;
  backend?: string;
  variant?: string;
  count?: number;
  wallMs?: number;
  statements?: number;
  rows?: number;
  baselineRssBytes?: number;
  peakRssBytes?: number;
  detail?: string;
}

/** The order the reference report lists its operations in. */
const ORDER = [
  "git.clone",
  "git.status (packed)",
  "git.add (all)",
  "git.commit",
  "git.diffSummary",
  "git.status (loose)",
];

function read(path: string): Row[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error(`${path} is not a result array`);
  const rows: Row[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record: Record<string, unknown> = { ...entry };
    const status = record.status;
    if (typeof status !== "string") continue;
    rows.push({
      status,
      operation: typeof record.operation === "string" ? record.operation : undefined,
      backend: typeof record.backend === "string" ? record.backend : undefined,
      variant: typeof record.variant === "string" ? record.variant : undefined,
      count: typeof record.count === "number" ? record.count : undefined,
      wallMs: typeof record.wallMs === "number" ? record.wallMs : undefined,
      statements: typeof record.statements === "number" ? record.statements : undefined,
      rows: typeof record.rows === "number" ? record.rows : undefined,
      baselineRssBytes:
        typeof record.baselineRssBytes === "number" ? record.baselineRssBytes : undefined,
      peakRssBytes: typeof record.peakRssBytes === "number" ? record.peakRssBytes : undefined,
      detail: typeof record.detail === "string" ? record.detail : undefined,
    });
  }
  return rows;
}

function ratio(baseline: number | undefined, subject: number | undefined): string {
  if (baseline === undefined || subject === undefined || subject === 0) return "—";
  const value = baseline / subject;
  return value >= 10 ? `${Math.round(value)}x` : `${value.toFixed(1)}x`;
}

const number = (value: number | undefined): string =>
  value === undefined ? "—" : value.toLocaleString("en-US");

const seconds = (value: number | undefined): string =>
  value === undefined ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;

const peak = (row: Row | undefined): string =>
  row?.peakRssBytes === undefined || row.baselineRssBytes === undefined
    ? "—"
    : `${((row.peakRssBytes - row.baselineRssBytes) / 1024 / 1024).toFixed(1)} MB`;

const rows = process.argv.slice(2).flatMap(read);
const variants = [...new Set(rows.map((row) => row.variant ?? "?"))];

const out: string[] = [];
for (const variant of variants) {
  const here = rows.filter((row) => row.variant === variant);
  out.push(`### ${variant}`, "");
  out.push(
    "| operation | dofs stmt | kompjutr stmt | reduction | dofs rows | kompjutr rows | dofs time | kompjutr time | dofs peak | kompjutr peak |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  const operations = [...new Set(here.map((row) => row.operation ?? "?"))].sort(
    (left, right) => ORDER.indexOf(left) - ORDER.indexOf(right),
  );
  for (const operation of operations) {
    const dofs = here.find((row) => row.operation === operation && row.backend === "dofs");
    const sqlite = here.find((row) => row.operation === operation && row.backend === "sqlite");
    out.push(
      `| \`${operation}\` | ${number(dofs?.statements)} | ${number(sqlite?.statements)} | ` +
        `${ratio(dofs?.statements, sqlite?.statements)} | ${number(dofs?.rows)} | ${number(sqlite?.rows)} | ` +
        `${seconds(dofs?.wallMs)} | ${seconds(sqlite?.wallMs)} | ${peak(dofs)} | ${peak(sqlite)} |`,
    );
  }
  out.push("");
  for (const failed of here.filter((row) => row.status !== "ok")) {
    out.push(
      `- **${failed.status}** ${failed.backend ?? "?"} ${failed.operation ?? ""}: ${failed.detail ?? ""}`,
    );
  }
  out.push("");
}
process.stdout.write(`${out.join("\n")}\n`);
