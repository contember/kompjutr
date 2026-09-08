import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalWorkspace, type LocalWorkspaceOptions } from "@kompjutr/local";

export interface LocalFixture {
  readonly base: string;
  readonly root: string;
  readonly state: string;
  readonly recovery: string;
  workspace(
    options?: Omit<LocalWorkspaceOptions, "root" | "stateDirectory" | "recoveryDirectory">,
  ): LocalWorkspace;
  dispose(): void;
}

export function localFixture(): LocalFixture {
  const base = mkdtempSync(join(tmpdir(), "kompjutr-local-test-"));
  const root = join(base, "root");
  const state = join(base, "state");
  const recovery = join(base, "recovery");
  mkdirSync(root);
  return {
    base,
    root,
    state,
    recovery,
    workspace: (options = {}) =>
      new LocalWorkspace({ root, stateDirectory: state, recoveryDirectory: recovery, ...options }),
    dispose: () => rmSync(base, { force: true, recursive: true }),
  };
}
