import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openResettableUpload } from "../../bench/server/cancellation.js";
import { startBenchmarkRuntime } from "../../bench/server/runtime.js";
import { activeOwners } from "../../bench/server/transfer-state.js";
import { runGit } from "../helpers/server-oracle-http.js";
import { basicAuth, WORKER_WRITE_TOKEN } from "../helpers/server-workerd.js";

it("releases a workerd upload owner on TCP reset while its yield is pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kompjutr-workerd-cancel-"));
  let release = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let pause = false;
  const server = await startBenchmarkRuntime("workerd", directory, async () => {
    if (pause) {
      entered();
      await gate;
    }
  });
  try {
    const source = join(directory, "source");
    await runGit(directory, ["init", "-b", "main", source]);
    await writeFile(join(source, "blob"), Buffer.alloc(256 * 1024, 120));
    await runGit(source, ["add", "blob"]);
    await runGit(source, ["commit", "-m", "cancellation fixture"]);
    const authorization = basicAuth(WORKER_WRITE_TOKEN);
    await runGit(source, [
      "-c",
      `http.extraHeader=Authorization: ${authorization}`,
      "push",
      `${server.url}/demo.git`,
      "main",
    ]);
    const head = (await runGit(source, ["rev-parse", "HEAD"])).stdout.toString().trim();
    pause = true;
    if (!("directUrl" in server) || typeof server.directUrl !== "string")
      throw new Error("no direct URL");
    const pending = openResettableUpload(
      `${server.directUrl}/demo.git/git-upload-pack`,
      authorization,
      head,
    );
    await blocked;
    const upload = await pending;
    expect(activeOwners(await server.transferState())).toBe(1);
    upload.reset();
    let active = activeOwners(await server.transferState());
    for (let poll = 0; active > 0 && poll < 100; poll++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      active = activeOwners(await server.transferState());
    }
    expect(active).toBe(0);
  } finally {
    pause = false;
    release();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
