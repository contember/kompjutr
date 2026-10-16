import { useEffect, useState } from "react";
import {
  type CommitDetail,
  commitSchema,
  type HistoryPage,
  historySchema,
} from "../shared/protocol.js";
import { type Measurement, request } from "./api.js";
import { ChangeSet, type RevisionTarget } from "./change-set.js";

interface Props {
  head: string;
  path: string | undefined;
  clearPath(): void;
  disabled: boolean;
  openRevision(target: RevisionTarget): void;
  onError(message: string): void;
  onMeasure(measurement: Measurement): void;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function CommitView({
  oid,
  select,
  back,
  disabled,
  openRevision,
  onError,
  onMeasure,
}: Omit<Props, "head" | "path" | "clearPath"> & {
  oid: string;
  select(oid: string): void;
  back(): void;
}) {
  const [commit, setCommit] = useState<CommitDetail>();
  const current = commit?.oid === oid ? commit : undefined;

  useEffect(() => {
    let cancelled = false;
    void request({ action: "show", ref: oid }, commitSchema)
      .then((result) => {
        if (cancelled) return;
        setCommit(result.data);
        onMeasure(result.measurement);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [oid, onError, onMeasure]);

  const subject = current?.message.split("\n")[0] ?? "";
  const body = current?.message.slice(subject.length).trim() ?? "";
  const base = current?.parents[0];
  return (
    <>
      <div className="commit-detail">
        <button type="button" className="quiet back-button" onClick={back}>
          ← History
        </button>
        {current === undefined ? (
          <div className="empty-state">Loading commit…</div>
        ) : (
          <>
            <h3>{subject}</h3>
            {body !== "" && <pre className="commit-body">{body}</pre>}
            <dl className="commit-meta">
              <dt>commit</dt>
              <dd>
                <code>{current.oid}</code>
              </dd>
              <dt>author</dt>
              <dd>
                {current.author.name} · {formatDate(current.author.timestamp)}
              </dd>
              {(current.committer.name !== current.author.name ||
                current.committer.timestamp !== current.author.timestamp) && (
                <>
                  <dt>committer</dt>
                  <dd>
                    {current.committer.name} · {formatDate(current.committer.timestamp)}
                  </dd>
                </>
              )}
              <dt>{current.parents.length === 1 ? "parent" : "parents"}</dt>
              <dd>
                {current.parents.length === 0 && "none (root commit)"}
                {current.parents.map((parent) => (
                  <button
                    type="button"
                    className="quiet commit-link"
                    key={parent}
                    disabled={disabled}
                    onClick={() => select(parent)}
                  >
                    {parent.slice(0, 8)}
                  </button>
                ))}
              </dd>
            </dl>
            {current.parents.length > 1 && (
              <div className="subtle">Merge commit · changes against the first parent</div>
            )}
          </>
        )}
      </div>
      {current !== undefined && base === undefined && (
        <div className="empty-state">
          The root commit adds its whole tree.
          <br />
          <span>Browse it in the explorer, or run git show in the terminal.</span>
        </div>
      )}
      {current !== undefined && base !== undefined && (
        <ChangeSet
          from={base}
          to={current.oid}
          disabled={disabled}
          openRevision={openRevision}
          onError={onError}
          onMeasure={onMeasure}
        />
      )}
    </>
  );
}

export function History({
  head,
  path,
  clearPath,
  disabled,
  openRevision,
  onError,
  onMeasure,
}: Props) {
  const [page, setPage] = useState<HistoryPage & { head: string; path: string | undefined }>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>();
  const current = page?.head === head && page.path === path ? page : undefined;

  useEffect(() => {
    let cancelled = false;
    void request({ action: "history", ref: head, path }, historySchema)
      .then((result) => {
        if (cancelled) return;
        setPage({ ...result.data, head, path });
        onMeasure(result.measurement);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [head, path, onError, onMeasure]);

  async function more() {
    if (current?.next === undefined || current.next === null || loading) return;
    setLoading(true);
    try {
      const result = await request({ action: "history", ref: current.next, path }, historySchema);
      setPage({
        commits: [...current.commits, ...result.data.commits],
        next: result.data.next,
        head,
        path,
      });
      onMeasure(result.measurement);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  if (selected !== undefined) {
    return (
      <CommitView
        disabled={disabled}
        openRevision={openRevision}
        onError={onError}
        onMeasure={onMeasure}
        oid={selected}
        select={setSelected}
        back={() => setSelected(undefined)}
      />
    );
  }
  return (
    <>
      {path !== undefined && (
        <div className="history-filter">
          <span title={path}>{path}</span>
          <button type="button" className="quiet" aria-label="Show all history" onClick={clearPath}>
            ✕
          </button>
        </div>
      )}
      <div className="inspector-scroll history-list">
        {current === undefined && <div className="empty-state">Loading history…</div>}
        {current?.commits.length === 0 && (
          <div className="empty-state">No first-parent commit changes this path.</div>
        )}
        {current?.commits.map((entry) => (
          <article className="history-entry" key={entry.oid}>
            <span className="history-dot" />
            <button
              type="button"
              className="history-open"
              disabled={disabled}
              onClick={() => setSelected(entry.oid)}
            >
              <span className="history-subject">{entry.message.split("\n")[0]}</span>
              <span className="history-author">
                {entry.author} <span>· {formatDate(entry.timestamp)}</span>
              </span>
              <code>{entry.oid.slice(0, 8)}</code>
            </button>
          </article>
        ))}
        {current?.next && (
          <button
            type="button"
            className="more-button"
            disabled={disabled || loading}
            onClick={() => void more()}
          >
            Older commits
          </button>
        )}
        <div className="fixture-note">
          First-parent history, 20 commits per page. Select a commit to see its changes. Use git log
          in the terminal to include merged branches.
        </div>
      </div>
    </>
  );
}
