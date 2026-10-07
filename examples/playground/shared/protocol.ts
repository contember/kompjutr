import { z } from "zod";

export const REPO = "/repo";
export const MAX_EDITOR_BYTES = 512 * 1024;
const path = z
  .string()
  .max(4096)
  .refine((value) => value.isWellFormed());
const cursor = z.object({ directory: path, path: path.nullable() });

export const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("state") }),
  z.object({ action: z.literal("clone") }),
  z.object({ action: z.literal("tree"), path, after: cursor.optional() }),
  z.object({ action: z.literal("file"), path }),
  z.object({ action: z.literal("save"), path, text: z.string(), version: z.string() }),
  z.object({ action: z.literal("shell"), source: z.string().min(1).max(16384) }),
  z.object({ action: z.literal("diff"), path, staged: z.boolean() }),
  z.object({ action: z.literal("stage"), path }),
  z.object({ action: z.literal("commit"), message: z.string().trim().min(1).max(4096) }),
  z.object({ action: z.literal("checkout"), branch: z.string().min(1).max(1024) }),
  z.object({ action: z.literal("history"), ref: z.string().max(1024).optional() }),
  z.object({
    action: z.literal("search"),
    query: z.string().min(1).max(512),
    after: path.optional(),
  }),
]);

export type ApiRequest = z.infer<typeof requestSchema>;
export const metricsSchema = z.object({ statements: z.number(), rowsReturned: z.number() });
export type Metrics = z.infer<typeof metricsSchema>;
export const stateSchema = z.object({
  ready: z.boolean(),
  branch: z.string(),
  head: z.string(),
  cwd: z.string(),
  filesystemRevision: z.number().int(),
  files: z.number(),
  branches: z.array(z.string()),
  changes: z.array(z.object({ path: z.string(), index: z.string(), worktree: z.string() })),
});
export type WorkspaceState = z.infer<typeof stateSchema>;
export const treeSchema = z.object({
  entries: z.array(z.object({ path: z.string(), name: z.string(), type: z.string() })),
  next: cursor.nullable(),
});
export type TreePage = z.infer<typeof treeSchema>;
export const fileSchema = z.object({
  path: z.string(),
  text: z.string(),
  version: z.string(),
  bytes: z.number(),
});
export type FileDocument = z.infer<typeof fileSchema>;
export const shellSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  cwd: z.string(),
  truncated: z.boolean(),
});
export type ShellResult = z.infer<typeof shellSchema>;
export const diffSchema = z.object({ patch: z.string() });
export const historySchema = z.object({
  commits: z.array(
    z.object({ oid: z.string(), message: z.string(), author: z.string(), timestamp: z.number() }),
  ),
  next: z.string().nullable(),
});
export type HistoryPage = z.infer<typeof historySchema>;
export const searchSchema = z.object({
  hits: z.array(z.object({ path: z.string(), confirmed: z.boolean() })),
  next: z.string().nullable(),
});
export type SearchPage = z.infer<typeof searchSchema>;
export const okSchema = z.object({ ok: z.literal(true) });
export const errorSchema = z.object({ error: z.string(), code: z.string() });
