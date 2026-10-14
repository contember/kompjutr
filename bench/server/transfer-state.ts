import type { SqlDatabase } from "@kompjutr/do";

export function transferState(db: SqlDatabase) {
  return {
    owners: db.scalar<number>("SELECT COUNT(*) FROM git_transfers"),
    activeOwners: db.scalar<number>("SELECT COUNT(*) FROM git_transfers WHERE released = 0"),
    scratch: db.scalar<number>("SELECT COUNT(*) FROM git_transfer_objects"),
  };
}

export function activeOwners(value: unknown): number {
  const count =
    typeof value === "object" && value !== null ? Reflect.get(value, "activeOwners") : undefined;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new Error("invalid transfer state");
  return count;
}
