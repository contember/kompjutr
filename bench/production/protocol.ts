export const PROBE_WORKER_NAME = "kompjutr-git-probe";
export const PROBE_FIXTURE_URL = "https://github.com/octocat/Hello-World.git";
export const PROBE_FIXTURE_BRANCH = "master";
export const PROBE_FIXTURE_HEAD = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
export const PROBE_FIXTURE_FETCH_BRANCH = "test";
export const PROBE_FIXTURE_FETCH_HEAD = "b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf";
export const PROBE_STATEMENT_TARGET = 1_000;
export const PROBE_RESPONSE_LIMIT = 1024 * 1024;
export const PROBE_HTTP_BODY_LIMIT = 32 * 1024 * 1024;

export type ProbeStatementTarget = "pass" | "miss";

export interface ProbeMetrics {
  statements: number;
  rows: number;
  statementTarget: ProbeStatementTarget;
}

export interface ProbeSuccess {
  ok: true;
  action: string;
  instanceId: string;
  constructorOrdinal: number;
  foreignKeysBefore: number;
  foreignKeysAfter: number;
  databaseBytes: number;
  metrics: ProbeMetrics;
  facts: unknown;
}

function required(value: object, key: string): unknown {
  const field = Reflect.get(value, key);
  if (field === undefined) throw new Error(`probe response omitted ${key}`);
  return field;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`probe response has invalid ${name}`);
  }
  return value;
}

export function probeStatementTarget(statements: number): ProbeStatementTarget {
  return statements <= PROBE_STATEMENT_TARGET ? "pass" : "miss";
}

export function probeSuccess(value: unknown): ProbeSuccess {
  if (typeof value !== "object" || value === null || Reflect.get(value, "ok") !== true) {
    throw new Error("probe response is not a success envelope");
  }
  const action = required(value, "action");
  const instanceId = required(value, "instanceId");
  const foreignKeysBefore = safeInteger(required(value, "foreignKeysBefore"), "foreignKeysBefore");
  const foreignKeysAfter = safeInteger(required(value, "foreignKeysAfter"), "foreignKeysAfter");
  const metricsValue = required(value, "metrics");
  if (typeof action !== "string" || action === "") {
    throw new Error("probe response has invalid action");
  }
  if (typeof instanceId !== "string" || instanceId === "") {
    throw new Error("probe response has invalid instanceId");
  }
  if (typeof metricsValue !== "object" || metricsValue === null) {
    throw new Error("probe response has invalid metrics");
  }
  const statements = safeInteger(required(metricsValue, "statements"), "metrics.statements");
  const statementTarget = required(metricsValue, "statementTarget");
  if (statementTarget !== "pass" && statementTarget !== "miss") {
    throw new Error("probe response has invalid metrics.statementTarget");
  }
  if (statementTarget !== probeStatementTarget(statements)) {
    throw new Error("probe response has invalid metrics.statementTarget");
  }
  return {
    ok: true,
    action,
    instanceId,
    constructorOrdinal: safeInteger(required(value, "constructorOrdinal"), "constructorOrdinal"),
    foreignKeysBefore,
    foreignKeysAfter,
    databaseBytes: safeInteger(required(value, "databaseBytes"), "databaseBytes"),
    metrics: {
      statements,
      rows: safeInteger(required(metricsValue, "rows"), "metrics.rows"),
      statementTarget,
    },
    facts: required(value, "facts"),
  };
}
