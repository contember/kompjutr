import { LocalWorkspace } from "@kompjutr/local";

const [root, stateDirectory, recoveryDirectory] = process.argv.slice(2);
if (root === undefined || stateDirectory === undefined || recoveryDirectory === undefined) {
  throw new Error("lock holder arguments are missing");
}

const workspace = new LocalWorkspace({ root, stateDirectory, recoveryDirectory });
process.send?.("ready");
process.on("SIGTERM", () => {
  workspace.close();
  process.exit(0);
});
setInterval(() => {}, 60_000);
