import { useEffect, useState } from "react";
import {
  diffSchema,
  type HistoryPage,
  historySchema,
  type SearchPage,
  searchSchema,
  type WorkspaceState,
} from "../shared/protocol.js";
import { type Measurement, request } from "./api.js";
import { PatchView } from "./patch-view.js";

export type InspectorTab = "search" | "changes" | "history";

interface Props {
  tab: InspectorTab;
  setTab(tab: InspectorTab): void;
  state: WorkspaceState;
  revision: number;
  disabled: boolean;
  open(path: string, query?: string): void;
  stage(path: string): void;
  commit(message: string): void;
  onError(message: string): void;
  onMeasure(measurement: Measurement): void;
}

function Search({ state, disabled, open, onError, onMeasure }: Props) {
  const revision = state.filesystemRevision;
  const [input, setInput] = useState("NextRequest");
  const [query, setQuery] = useState("NextRequest");
  const [attempt, setAttempt] = useState(0);
  const [resultPage, setPage] = useState<SearchPage & { revision: number; attempt: number }>();
  const page =
    resultPage?.revision === revision && resultPage.attempt === attempt ? resultPage : undefined;
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(undefined);
    void request({ action: "search", query }, searchSchema)
      .then((result) => {
        if (cancelled) return;
        setPage({ ...result.data, revision, attempt });
        onMeasure(result.measurement);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, revision, attempt, onError, onMeasure]);

  async function more() {
    if (page?.next === undefined || page.next === null || loading) return;
    setLoading(true);
    try {
      const result = await request({ action: "search", query, after: page.next }, searchSchema);
      setPage({
        hits: [...page.hits, ...result.data.hits],
        next: result.data.next,
        revision,
        attempt,
      });
      onMeasure(result.measurement);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim() === "") return;
          setQuery(input);
          setAttempt((value) => value + 1);
        }}
      >
        <label htmlFor="search">Find text across the workspace</label>
        <div className="search-control">
          <input
            id="search"
            value={input}
            maxLength={512}
            spellCheck={false}
            onChange={(event) => setInput(event.target.value)}
          />
          <button
            type="submit"
            disabled={disabled || loading || input === ""}
            aria-label="Search repository"
          >
            ↵
          </button>
        </div>
        <div className="subtle">Literal content search · runs in SQLite</div>
      </form>
      <div className="section-label">
        {loading
          ? "SEARCHING…"
          : `${page?.hits.filter((hit) => hit.confirmed).length ?? 0} MATCHING FILES${page?.next ? " · MORE AVAILABLE" : ""}`}
      </div>
      <div className="inspector-scroll">
        {page?.hits
          .filter((hit) => hit.confirmed)
          .map((hit) => (
            <button
              type="button"
              key={hit.path}
              className="search-hit"
              title={hit.path}
              disabled={disabled}
              onClick={() => open(hit.path, query)}
            >
              <span className="hit-name">{hit.path.slice(hit.path.lastIndexOf("/") + 1)}</span>
              <span className="hit-path">{hit.path}</span>
            </button>
          ))}
        {page?.hits.some((hit) => !hit.confirmed) && (
          <details className="search-candidates">
            <summary>
              {page.hits.filter((hit) => !hit.confirmed).length} large files need verification
            </summary>
            <p>
              These files may contain a match across storage chunks. Verify them with rg in the
              terminal.
            </p>
            {page.hits
              .filter((hit) => !hit.confirmed)
              .map((hit) => (
                <div className="hit-path" title={hit.path} key={hit.path}>
                  {hit.path}
                </div>
              ))}
          </details>
        )}
        {!loading && page?.hits.length === 0 && (
          <div className="empty-state">No matching files.</div>
        )}
        {page?.next && (
          <button
            type="button"
            className="more-button"
            disabled={disabled || loading}
            onClick={() => void more()}
          >
            Load next page
          </button>
        )}
      </div>
    </>
  );
}

function Changes({ state, revision, disabled, open, stage, commit, onError, onMeasure }: Props) {
  const [selected, setSelected] = useState("");
  const [staged, setStaged] = useState(false);
  const [resultPatch, setPatch] = useState<{
    text: string;
    path: string;
    staged: boolean;
    revision: number;
  }>();
  const patch =
    resultPatch?.revision === revision &&
    resultPatch.path === selected &&
    resultPatch.staged === staged
      ? resultPatch.text
      : "";
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (selected === "") return;
    let cancelled = false;
    void request({ action: "diff", path: selected, staged }, diffSchema)
      .then((result) => {
        if (!cancelled) {
          setPatch({ text: result.data.patch, path: selected, staged, revision });
          onMeasure(result.measurement);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, staged, revision, onError, onMeasure]);

  return (
    <>
      <form
        className="commit-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (message.trim() === "") return;
          commit(message);
        }}
      >
        <input
          aria-label="Commit message"
          placeholder="Commit message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <button
          type="submit"
          className="accent-button"
          disabled={
            disabled ||
            message.trim() === "" ||
            !state.changes.some((change) => change.index !== " " && change.index !== "?")
          }
        >
          Commit staged
        </button>
      </form>
      <div className="section-label">{state.changes.length} CHANGED FILES</div>
      <div className="changes-list">
        {state.changes.length === 0 && (
          <div className="empty-state">
            Working tree clean.
            <br />
            <span>Edit a file or use the terminal.</span>
          </div>
        )}
        {state.changes.map((change) => (
          <div
            key={change.path}
            className={`change-row ${selected === change.path ? "selected" : ""}`}
          >
            <button
              type="button"
              className="change-path"
              title={change.path}
              disabled={disabled}
              onClick={() => {
                setSelected(change.path);
                setStaged(change.index !== " " && change.worktree === " ");
              }}
            >
              <span className="change-code">
                {`${change.index}${change.worktree}`.trim() || "M"}
              </span>
              {change.path}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              aria-label={`Open ${change.path}`}
              onClick={() => open(change.path)}
            >
              ↗
            </button>
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              aria-label={`Stage ${change.path}`}
              onClick={() => stage(change.path)}
            >
              +
            </button>
          </div>
        ))}
      </div>
      {selected !== "" && (
        <>
          <div className="diff-heading">
            <span title={selected}>{selected.split("/").at(-1)}</span>
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              onClick={() => setStaged(!staged)}
            >
              {staged ? "Staged" : "Working tree"} ⇄
            </button>
          </div>
          {patch === "" ? (
            <div className="empty-state">
              No diff for this selection. Untracked files appear after staging.
            </div>
          ) : (
            <PatchView patch={patch} />
          )}
        </>
      )}
    </>
  );
}

function History({ state, disabled, onError }: Props) {
  const [page, setPage] = useState<HistoryPage>();
  const [loading, setLoading] = useState(false);
  const head = state.head;

  useEffect(() => {
    let cancelled = false;
    void request({ action: "history", ref: head }, historySchema)
      .then(({ data }) => {
        if (!cancelled) setPage(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [head, onError]);

  async function more() {
    if (page?.next === undefined || page.next === null || loading) return;
    setLoading(true);
    try {
      const result = await request({ action: "history", ref: page.next }, historySchema);
      setPage({ commits: [...page.commits, ...result.data.commits], next: result.data.next });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="inspector-scroll history-list">
      {page?.commits.map((entry) => (
        <article className="history-entry" key={entry.oid}>
          <span className="history-dot" />
          <div>
            <h3>{entry.message.split("\n")[0]}</h3>
            <p>
              {entry.author}{" "}
              <span>
                ·{" "}
                {new Date(entry.timestamp * 1000).toLocaleDateString("en", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </p>
            <code>{entry.oid.slice(0, 8)}</code>
          </div>
        </article>
      ))}
      {page?.next && (
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
        First-parent history, 20 commits per page. Use git log in the terminal to include merged
        branches.
      </div>
    </div>
  );
}

export function Inspector(props: Props) {
  return (
    <aside className="inspector" aria-label="Repository tools">
      <nav className="inspector-tabs" aria-label="Repository views">
        <button
          type="button"
          aria-pressed={props.tab === "search"}
          onClick={() => props.setTab("search")}
        >
          Search
        </button>
        <button
          type="button"
          aria-pressed={props.tab === "changes"}
          onClick={() => props.setTab("changes")}
        >
          Changes <span>{props.state.changes.length}</span>
        </button>
        <button
          type="button"
          aria-pressed={props.tab === "history"}
          onClick={() => props.setTab("history")}
        >
          History
        </button>
      </nav>
      {props.tab === "search" && <Search {...props} />}
      {props.tab === "changes" && <Changes {...props} />}
      {props.tab === "history" && <History {...props} />}
    </aside>
  );
}
