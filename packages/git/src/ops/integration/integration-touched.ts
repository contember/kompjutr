import { dirnameOf } from "../../common/paths.js";
import type { ProjectedMergeEntry } from "../../store/operations/integration-workspace/descriptors.js";
import type { IntegrationPlanHandle } from "../../store/operations/integration-workspace/storage.js";
import type {
  IntegrationTouched,
  IntegrationTouchedShape,
} from "../../store/operations/integration-workspace/touched.js";
import type { IntegrationWorkspace } from "../../store/operations/integration-workspace/workspace.js";

export function integrationTouched(
  workspace: IntegrationWorkspace,
  projected: IntegrationPlanHandle<ProjectedMergeEntry>,
): IntegrationTouched {
  const touched = workspace.touched(projected);
  function* ancestors(path: string): Generator<IntegrationTouchedShape> {
    let parent = dirnameOf(path);
    while (parent !== "/") {
      const relative = parent.slice(1);
      yield { path: relative, logicalPath: relative, purpose: "primary" };
      parent = dirnameOf(parent);
    }
  }
  function* shapes(): Generator<IntegrationTouchedShape> {
    for (const entry of projected.entries) {
      yield { path: entry.path, logicalPath: entry.logicalPath, purpose: entry.purpose };
      if (entry.purpose !== "primary")
        yield { path: entry.logicalPath, logicalPath: entry.logicalPath, purpose: "primary" };
      yield* ancestors(entry.path);
      yield* ancestors(entry.logicalPath);
    }
  }
  touched.reserve(shapes());
  return touched;
}
