import { LocalWorkspace } from "@kompjutr/local";

const [root, stateDirectory, recoveryDirectory] = process.argv.slice(2);
if (root === undefined || stateDirectory === undefined || recoveryDirectory === undefined) {
  throw new Error("lock contender arguments are missing");
}

try {
  const workspace = new LocalWorkspace({ root, stateDirectory, recoveryDirectory });
  process.send?.("ready");
  process.on("message", (message) => {
    if (message !== "close") return;
    workspace.close();
    process.exit(0);
  });
  setInterval(() => {}, 60_000);
} catch (error) {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  process.send?.(code === "EBUSY" ? "busy" : "error");
  process.exit(code === "EBUSY" ? 0 : 1);
}
