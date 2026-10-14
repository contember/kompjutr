import { get } from "node:http";

/** A control probe must not reuse a connection idle during a long Git request. */
export function benchmarkControl(origin: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(`${origin}/__bench/${path}`, { agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: unknown) => {
        if (typeof chunk !== "string") {
          request.destroy(new Error("benchmark control returned non-text data"));
          return;
        }
        body += chunk;
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`benchmark control ${path}: HTTP ${response.statusCode}: ${body}`));
          return;
        }
        try {
          const value: unknown = JSON.parse(body);
          resolve(value);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

export function phaseCounts(value: unknown, phase: string) {
  if (typeof value !== "object" || value === null) throw new Error("invalid phase counters");
  if (Reflect.get(value, "phase") !== phase)
    throw new Error("benchmark phase epoch lost; isolate counters are incomplete");
  const count = (key: string) => {
    const result: unknown = Reflect.get(value, key);
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
      throw new Error(`invalid phase counter: ${key}`);
    return result;
  };
  return {
    phase,
    generations: count("generations"),
    statements: count("statements"),
    returnedRows: count("returnedRows"),
  };
}
