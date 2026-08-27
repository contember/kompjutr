import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PROBE_RESPONSE_LIMIT } from "./protocol.js";

const query = `query GetWorkersAnalytics(
  $accountTag: string,
  $datetimeStart: string,
  $datetimeEnd: string,
  $scriptName: string
) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      workersInvocationsAdaptive(
        limit: 100,
        filter: {
          scriptName: $scriptName,
          datetime_geq: $datetimeStart,
          datetime_leq: $datetimeEnd
        }
      ) {
        sum { subrequests requests errors }
        quantiles { cpuTimeP50 cpuTimeP99 memoryUsageBytesP50 memoryUsageBytesP99 }
        dimensions { datetime scriptName status }
      }
    }
  }
}`;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function object(value: unknown, name: string): object {
  if (typeof value !== "object" || value === null) throw new Error(`${name} is not an object`);
  return value;
}

function stringField(value: object, key: string): string {
  const field = Reflect.get(value, key);
  if (typeof field !== "string" || field === "") throw new Error(`evidence has no ${key}`);
  return field;
}

function oauthToken(): string {
  const configured = process.env.CLOUDFLARE_API_TOKEN;
  if (configured !== undefined && configured !== "") return configured;
  const output = execFileSync(
    join(process.cwd(), "node_modules/.bin/wrangler"),
    ["auth", "token", "--json"],
    { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const parsed: unknown = JSON.parse(output);
  return stringField(object(parsed, "Wrangler token response"), "token");
}

function analyticsWindow(
  startedAt: string,
  finishedAt: string,
): {
  datetimeStart: string;
  datetimeEnd: string;
} {
  const start = new Date(startedAt);
  const end = new Date(finishedAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("evidence contains an invalid time window");
  }
  start.setMilliseconds(0);
  end.setMilliseconds(0);
  end.setSeconds(end.getSeconds() + 1);
  return { datetimeStart: start.toISOString(), datetimeEnd: end.toISOString() };
}

const evidencePath = argument("evidence");
if (evidencePath === undefined || evidencePath === "") {
  throw new Error("--evidence=bench/results/production-do-....json is required");
}
const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID;
if (accountTag === undefined || accountTag === "") {
  throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
}
const evidence: unknown = JSON.parse(readFileSync(evidencePath, "utf8"));
const evidenceObject = object(evidence, "evidence");
const worker = stringField(evidenceObject, "worker");
const window = analyticsWindow(
  stringField(evidenceObject, "startedAt"),
  stringField(evidenceObject, "finishedAt"),
);
const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
  method: "POST",
  headers: {
    authorization: `Bearer ${oauthToken()}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    query,
    variables: { accountTag, scriptName: worker, ...window },
  }),
  signal: AbortSignal.timeout(30_000),
});
const bytes = new Uint8Array(await response.arrayBuffer());
if (bytes.length > PROBE_RESPONSE_LIMIT) {
  throw new Error(`analytics response has ${bytes.length} bytes; limit is ${PROBE_RESPONSE_LIMIT}`);
}
const body = new TextDecoder().decode(bytes);
if (!response.ok) throw new Error(`analytics query failed with HTTP ${response.status}: ${body}`);
const result: unknown = JSON.parse(body);
const resultObject = object(result, "analytics response");
const errors = Reflect.get(resultObject, "errors");
if (errors !== null && errors !== undefined) {
  throw new Error(`analytics query returned errors: ${JSON.stringify(errors)}`);
}
const output = evidencePath.replace(/\.json$/, ".analytics.json");
writeFileSync(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      worker,
      queriedAt: new Date().toISOString(),
      dataset: "workersInvocationsAdaptive",
      window,
      result,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log(`Workers analytics written to ${output}`);
