import type { GitContext } from "./ops/context.js";
import type { Repository } from "./ops/repository.js";

export interface GitClientServices {
  readonly context: GitContext;
  at(dir?: string): Repository;
  excludeRoots(repo: Repository): string[];
  mutate<T>(body: () => T): T;
}
