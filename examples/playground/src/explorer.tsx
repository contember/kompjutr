import { useEffect, useState } from "react";
import { type TreePage, treeSchema } from "../shared/protocol.js";
import { request } from "./api.js";

interface Props {
  revision: number;
  selected: string;
  disabled: boolean;
  open(path: string): void;
  onError(message: string): void;
}

function fileLabel(path: string): string {
  if (/\.tsx?$/.test(path)) return "TS";
  if (/\.[cm]?jsx?$/.test(path)) return "JS";
  if (path.endsWith(".json")) return "{}";
  if (path.endsWith(".md")) return "M↓";
  return "·";
}

function Directory({
  path,
  name,
  depth,
  ...props
}: Props & { path: string; name: string; depth: number }) {
  const [expanded, setExpanded] = useState(path === "");
  const [page, setPage] = useState<TreePage>();
  const [loading, setLoading] = useState(false);
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const { revision, onError } = props;

  useEffect(() => {
    if (!expanded || loadedRevision === revision) return;
    let cancelled = false;
    setLoading(true);
    void request({ action: "tree", path }, treeSchema)
      .then(({ data }) => {
        if (!cancelled) {
          setPage(data);
          setLoadedRevision(revision);
          setLoading(false);
        }
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
  }, [expanded, path, revision, loadedRevision, onError]);

  async function more() {
    if (page?.next === null || page?.next === undefined || loading) return;
    setLoading(true);
    try {
      const result = await request({ action: "tree", path, after: page.next }, treeSchema);
      setPage({ entries: [...page.entries, ...result.data.entries], next: result.data.next });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {path !== "" && (
        <button
          type="button"
          className="tree-row directory-row"
          style={{ paddingLeft: 12 + depth * 14 }}
          aria-expanded={expanded}
          disabled={props.disabled}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="disclosure">{expanded ? "▾" : "▸"}</span>
          <span className="folder-icon">▱</span>
          <span>{name}</span>
        </button>
      )}
      {expanded && (
        <div className="directory-children">
          {page?.entries.map((entry) =>
            entry.type === "dir" ? (
              <Directory
                key={entry.path}
                {...props}
                path={entry.path}
                name={entry.name}
                depth={depth + 1}
              />
            ) : (
              <button
                type="button"
                className={`tree-row file-row ${props.selected === entry.path ? "selected" : ""}`}
                key={entry.path}
                style={{ paddingLeft: 26 + (depth + 1) * 14 }}
                title={entry.path}
                disabled={props.disabled}
                onClick={() => props.open(entry.path)}
              >
                <span className="file-icon">{fileLabel(entry.path)}</span>
                <span>{entry.name}</span>
              </button>
            ),
          )}
          {loading && <div className="tree-note">Loading…</div>}
          {page?.next !== null && page?.next !== undefined && (
            <button
              type="button"
              className="more-button"
              disabled={loading || props.disabled}
              onClick={() => void more()}
            >
              Load more files
            </button>
          )}
        </div>
      )}
    </>
  );
}

export function Explorer(props: Props) {
  return (
    <aside className="explorer" aria-label="File explorer">
      <div className="panel-heading">
        EXPLORER <span className="subtle">/ lazy-loaded</span>
      </div>
      <div className="repo-root">
        <span>▾</span> NEXT.JS <span className="subtle">v15.5.2</span>
      </div>
      <div className="tree-scroll">
        <Directory {...props} path="" name="next.js" depth={-1} />
      </div>
      <div className="explorer-foot">
        Full source tree
        <br />
        <span>SQLite workspace · upstream v15.5.2</span>
      </div>
    </aside>
  );
}
