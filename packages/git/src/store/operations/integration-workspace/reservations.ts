import { expectText } from "../../../common/rows.js";
import { requireBooleanProbe } from "../../core/json-pages.js";
import { type IntegrationReservation, reservationDescriptor } from "./descriptors.js";
import {
  decodeDescriptor,
  type IntegrationWorkspaceOwner,
  integrationJsonPages,
} from "./storage.js";

export type IntegrationReservationFamily =
  | "occupied"
  | "tracked"
  | "untracked"
  | "virtual"
  | "writes";

export class IntegrationReservations {
  constructor(
    private readonly owner: IntegrationWorkspaceOwner,
    private readonly planId: number,
    private readonly family: IntegrationReservationFamily,
  ) {}

  add(entries: Iterable<IntegrationReservation>): void {
    const owner = this.owner;
    owner.requireActive();
    for (const page of integrationJsonPages(this.checked(entries))) {
      owner.requireActive();
      owner.db.run(
        `INSERT INTO git_integration_reservations (repo_id, workspace_id, plan_id, family, path, descriptor)
         SELECT ?, ?, ?, ?, json_extract(value, '$.path'), value FROM json_each(?) WHERE 1
         ON CONFLICT (repo_id, workspace_id, plan_id, family, path) DO NOTHING`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        this.family,
        page,
      );
    }
  }

  private *checked(entries: Iterable<IntegrationReservation>): Generator<IntegrationReservation> {
    for (const entry of entries) yield decodeDescriptor(reservationDescriptor, entry, false);
  }

  has(path: string): boolean {
    const owner = this.owner;
    owner.requireActive();
    return requireBooleanProbe(
      owner.db.scalar(
        `SELECT EXISTS(SELECT 1 FROM git_integration_reservations
       WHERE repo_id = ? AND workspace_id = ? AND plan_id = ? AND family = ? AND path = ?)`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        this.family,
        path,
      ),
      "integration reservation membership",
    );
  }

  hasDescendant(path: string): boolean {
    const owner = this.owner;
    owner.requireActive();
    return requireBooleanProbe(
      owner.db.scalar(
        `SELECT EXISTS(SELECT 1 FROM git_integration_reservations
       WHERE repo_id = ? AND workspace_id = ? AND plan_id = ? AND family = ?
         AND path >= ? COLLATE BINARY AND path < ? COLLATE BINARY)`,
        owner.repoId,
        owner.workspaceId,
        this.planId,
        this.family,
        `${path}/`,
        `${path}0`,
      ),
      "integration reservation prefix membership",
    );
  }

  get(path: string): IntegrationReservation | null {
    const owner = this.owner;
    owner.requireActive();
    const row = owner.db.one<{ descriptor: unknown }>(
      `SELECT descriptor FROM git_integration_reservations
       WHERE repo_id = ? AND workspace_id = ? AND plan_id = ? AND family = ? AND path = ?`,
      owner.repoId,
      owner.workspaceId,
      this.planId,
      this.family,
      path,
    );
    if (row === undefined) return null;
    const value: unknown = JSON.parse(expectText(row.descriptor));
    return decodeDescriptor(reservationDescriptor, value, true);
  }
}
