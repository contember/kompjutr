import { z } from "zod";
import { type ApiRequest, errorSchema, metricsSchema } from "../shared/protocol.js";

export interface Measurement {
  action: string;
  milliseconds: number;
  statements: number;
  rowsReturned: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function request<T>(input: ApiRequest, schema: z.ZodType<T>) {
  const started = performance.now();
  const response = await fetch("/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = errorSchema.parse(value);
    throw new ApiError(error.error, error.code);
  }
  const parsed = z.object({ data: schema, metrics: metricsSchema }).parse(value);
  const milliseconds = performance.now() - started;
  return {
    data: parsed.data,
    measurement: { action: input.action, milliseconds, ...parsed.metrics },
  };
}
