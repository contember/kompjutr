import { type DurableObjectStorageLike, Workspace } from "@kompjutr/do";
import { createGitCommand } from "@kompjutr/do/git-shell";
import { createShell, type Shell } from "@kompjutr/do/shell";
import { createGit } from "@kompjutr/git";
import { z } from "zod";
import { comparePaths } from "../../../packages/do/src/fs/path.js";
import { NEEDLE_MAX_BYTES } from "../../../packages/do/src/fs/store/search.js";
import { type ApiRequest, REPO, requestSchema } from "../shared/protocol.js";
import { CountingStorage } from "./counting-storage.js";
import { RequestError, readDocument, resolvedPath, saveDocument, workspacePath } from "./files.js";
import {
  changes,
  compare,
  history,
  revisionFile,
  revisionPatch,
  showCommit,
  workingTreePatch,
} from "./git-views.js";

interface Environment {
  ORIGIN_URL: string;
  CLONE_FILTER: string;
  PLAYGROUND: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (typeof error.code === "string") return error.code;
  }
  return "EINTERNAL";
}

export class Playground {
  readonly #storage: CountingStorage;
  readonly #workspace: Workspace;
  readonly #shell: Shell;
  readonly #cloneFilter: "none" | "blob:none";
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    context: { storage: DurableObjectStorageLike },
    private readonly environment: Environment,
  ) {
    this.#cloneFilter = z.enum(["none", "blob:none"]).parse(environment.CLONE_FILTER);
    this.#storage = new CountingStorage(context.storage);
    this.#workspace = new Workspace({
      storage: this.#storage,
      git: createGit(),
      defaultGitIdentity: { name: "Playground", email: "playground@example.com" },
    });
    this.#shell = createShell({
      fs: this.#workspace.filesystem,
      sessionId: "playground",
      cwd: REPO,
      commands: new Map([["git", createGitCommand(this.#workspace.git)]]),
    });
  }

  fetch(request: Request): Promise<Response> {
    // One operation owns both mutations and its SQL counters, even across network awaits.
    const response = this.#queue.then(() => this.#handle(request));
    this.#queue = response.catch(() => {});
    return response;
  }

  async #handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    try {
      if (!request.headers.get("content-type")?.startsWith("application/json")) {
        throw new RequestError("EINVAL", "Expected application/json");
      }
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024) {
        throw new RequestError("EFBIG", "Request exceeds 4 MiB", 413);
      }
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        throw new RequestError("EINVAL", "Invalid JSON");
      }
      const parsed = requestSchema.safeParse(value);
      if (!parsed.success) throw new RequestError("EINVAL", parsed.error.message);
      this.#storage.reset();
      const data = await this.#dispatch(parsed.data);
      return Response.json(
        {
          data,
          metrics: {
            statements: this.#storage.statements,
            rowsReturned: this.#storage.rowsReturned,
          },
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error), code: errorCode(error) },
        { status: error instanceof RequestError ? error.status : 500 },
      );
    }
  }

  async #ready(): Promise<boolean> {
    try {
      return (await this.#workspace.git.tryRevParse({ dir: REPO, ref: "HEAD" })) !== undefined;
    } catch (error) {
      if (errorCode(error) === "ENOTAREPO") return false;
      throw error;
    }
  }

  async #state() {
    if (!(await this.#ready())) {
      return {
        ready: false,
        branch: "",
        head: "",
        cwd: this.#shell.cwd(),
        filesystemRevision: this.#workspace.filesystem.rev(),
        files: 0,
        branches: [],
        changes: [],
      };
    }
    const git = this.#workspace.git;
    return {
      ready: true,
      branch: (await git.currentBranch({ dir: REPO })) ?? "detached",
      head: await git.revParse({ dir: REPO, ref: "HEAD" }),
      cwd: this.#shell.cwd(),
      filesystemRevision: this.#workspace.filesystem.rev(),
      files: this.#workspace.db.scalar<number>(
        "SELECT COUNT(*) FROM fs_paths p JOIN fs_nodes n ON p.inode = n.inode WHERE p.path GLOB '/repo/*' AND n.type <> 'dir'",
      ),
      branches: await git.branchList({ dir: REPO }),
      changes: await git.status({ dir: REPO }),
    };
  }

  async #dispatch(input: ApiRequest): Promise<unknown> {
    const workspace = this.#workspace;
    const git = workspace.git;
    switch (input.action) {
      case "state":
        return this.#state();
      case "clone":
        if (!(await this.#ready())) {
          await git.clone({
            url: this.environment.ORIGIN_URL,
            dir: REPO,
            ref: "main",
            singleBranch: true,
            ...(this.#cloneFilter === "none" ? {} : { filter: this.#cloneFilter }),
          });
        }
        return this.#state();
      case "tree": {
        const root = resolvedPath(workspace, input.path);
        if (input.after !== undefined) {
          if (
            input.after.directory !== root ||
            (input.after.path !== null && !input.after.path.startsWith(`${root}/`))
          ) {
            throw new RequestError("EINVAL", "Directory cursor does not match the requested path");
          }
        }
        const page = workspace.filesystem.listEntries(root, { limit: 100, after: input.after });
        return {
          entries: page.items.flatMap(({ entry }) =>
            entry === null
              ? []
              : [
                  {
                    path: entry.path.slice(REPO.length + 1),
                    name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
                    type: entry.type,
                  },
                ],
          ),
          next: page.next,
        };
      }
      case "file":
        return readDocument(workspace, input.path);
      case "save":
        return saveDocument(workspace, input.path, input.text, input.version);
      case "shell":
        return this.#shell.run(input.source);
      case "diff":
        return { patch: await workingTreePatch(git, input.path, input.staged) };
      case "stage":
        workspacePath(input.path);
        await git.add({ dir: REPO, paths: [input.path] });
        return { ok: true };
      case "commit":
        await git.commit({ dir: REPO, message: input.message });
        return { ok: true };
      case "checkout":
        await git.checkout({ dir: REPO, ref: input.branch });
        return { ok: true };
      case "branch":
        await git.branch({ dir: REPO, name: input.name, checkout: true });
        return { ok: true };
      case "history":
        return history(git, input.ref, input.path);
      case "show":
        return showCommit(git, input.ref);
      case "changes":
        return changes(git, input.from, input.to);
      case "patch":
        return { patch: await revisionPatch(git, input.from, input.to, input.paths) };
      case "blob":
        return revisionFile(git, input.ref, input.path);
      case "compare":
        return compare(git, input.base, input.head);
      case "search": {
        const fs = workspace.filesystem;
        const needle = new TextEncoder().encode(input.query);
        if (!input.query.isWellFormed() || needle.byteLength > NEEDLE_MAX_BYTES) {
          throw new RequestError(
            "EINVAL",
            `Search text must be valid UTF-8 and at most ${NEEDLE_MAX_BYTES} bytes`,
          );
        }
        const page = fs.discoverFilesContaining(fs.realpath(REPO), "*", needle, {
          limit: 100,
          excludeBinary: true,
          after:
            input.after === undefined
              ? undefined
              : fs.realpath(resolvedPath(workspace, input.after)),
        });
        return {
          hits: [
            ...page.matched.map((handle) => ({
              path: handle.path.slice(REPO.length + 1),
              confirmed: true,
            })),
            ...page.undecided.map((handle) => ({
              path: handle.path.slice(REPO.length + 1),
              confirmed: false,
            })),
          ].sort((left, right) => comparePaths(left.path, right.path)),
          next: page.next === null ? null : page.next.slice(REPO.length + 1),
        };
      }
    }
  }
}

export default {
  fetch(request: Request, environment: Environment): Promise<Response> | Response {
    if (new URL(request.url).pathname !== "/api") return new Response("Not found", { status: 404 });
    return environment.PLAYGROUND.getByName("nextjs").fetch(request);
  },
};
