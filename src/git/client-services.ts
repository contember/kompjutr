import type { GitContext } from "./ops/core/context.js";
import type { Repository } from "./ops/repository/repository.js";

export interface GitClientServices {
  readonly context: GitContext;
  at(dir?: string): Repository;
  excludeRoots(repo: Repository): string[];
  mutate<T>(body: () => T): T;
}
