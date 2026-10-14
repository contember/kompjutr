import type { SqlDatabase } from "@kompjutr/sqlite";
import { GitError } from "../../common/errors.js";
import type { CheckoutRow } from "../core/contracts.js";
import { jsonPages } from "../core/json-pages.js";
import { requireStoredCheckoutRow } from "../database/lifecycle.js";
import { MAX_CHECKOUTS_PER_REPOSITORY } from "../schema/schema.js";
import { type CheckoutRefLogEvent, REFLOG_RETENTION_ROWS } from "./reflog.js";
import type { RepositoryHeadOwner } from "./refs.js";

/** Repository-wide HEAD effects do not require selecting a checkout. */
export class RepositoryHeads implements RepositoryHeadOwner {
  readonly kind = "repository";

  constructor(
    private readonly database: SqlDatabase,
    private readonly repoId: number,
    private readonly requireActive: () => void,
  ) {}

  #db(): SqlDatabase {
    this.requireActive();
    return this.database;
  }

  readRefMutationHeads(): CheckoutRow[] {
    const checkouts: CheckoutRow[] = [];
    for (const raw of this.#db().iterate(
      `SELECT id AS checkout_id, repo_id, root, head, is_primary
         FROM git_checkouts WHERE repo_id = ? ORDER BY id
         LIMIT ${MAX_CHECKOUTS_PER_REPOSITORY + 1}`,
      this.repoId,
    )) {
      checkouts.push(requireStoredCheckoutRow(raw));
      if (checkouts.length > MAX_CHECKOUTS_PER_REPOSITORY) {
        throw new GitError("E2BIG", "repository checkout state exceeds its retained bound");
      }
    }
    return checkouts;
  }

  appendCheckoutRefLogs(events: readonly CheckoutRefLogEvent[]): void {
    for (const page of jsonPages(events, "checkout reflog entry")) {
      this.#db().run(
        `INSERT INTO git_checkout_reflog_entries
           (checkout_id, repo_id, ordinal, old_raw, new_raw, old_oid, new_oid,
            actor_name, actor_email, timestamp, timezone, reason)
         SELECT json_extract(value, '$.checkoutId'), ?,
                json_extract(value, '$.ordinal'),
                json_extract(value, '$.oldRaw'),
                json_extract(value, '$.newRaw'),
                json_extract(value, '$.oldOid'),
                json_extract(value, '$.newOid'),
                json_extract(value, '$.actorName'),
                json_extract(value, '$.actorEmail'),
                json_extract(value, '$.timestamp'),
                json_extract(value, '$.timezoneOffset'),
                json_extract(value, '$.reason')
           FROM json_each(?)`,
        this.repoId,
        page,
      );
    }
  }

  pruneExpiredCheckoutRefLogs(cutoff: number): void {
    this.#db().run(
      "DELETE FROM git_checkout_reflog_entries WHERE repo_id = ? AND timestamp < ?",
      this.repoId,
      cutoff,
    );
  }

  pruneRetainedCheckoutRefLogs(events: readonly CheckoutRefLogEvent[]): void {
    const touchedCheckouts = events.map((event) => event.checkoutId);
    for (const page of jsonPages(touchedCheckouts, "checkout reflog retention")) {
      this.#db().run(
        `DELETE FROM git_checkout_reflog_entries AS entry
          WHERE entry.repo_id = ?
            AND entry.checkout_id IN (SELECT value FROM json_each(?))
            AND entry.ordinal < coalesce((
              SELECT retained.ordinal
                FROM git_checkout_reflog_entries retained
               WHERE retained.checkout_id = entry.checkout_id
               ORDER BY retained.ordinal DESC
               LIMIT 1 OFFSET ${REFLOG_RETENTION_ROWS - 1}
            ), 0)`,
        this.repoId,
        page,
      );
    }
  }
}
