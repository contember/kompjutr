import { useRef, useState } from "react";
import { Editor } from "./editor.js";
import { Explorer } from "./explorer.js";
import { Inspector, type InspectorTab } from "./inspector.js";
import { Terminal } from "./terminal.js";
import { useWorkspace } from "./use-workspace.js";

export function App() {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<InspectorTab>("search");
  const [query, setQuery] = useState("");
  const branchMenu = useRef<HTMLDetailsElement>(null);
  const state = workspace.state;
  const busy = workspace.pending !== "";
  const file = workspace.document;

  function open(path: string, search = "") {
    setQuery(search);
    void workspace.open(path);
  }

  return (
    <main className="playground">
      <header className="workspace-header">
        <div className="wordmark">
          <span className="brand-mark">k_</span> kompjutr<span className="edition">PLAYGROUND</span>
        </div>
        <div className="workspace-identity">
          <span className="repo-symbol">▱</span>
          <strong>vercel / next.js</strong>
          <span className="file-count">
            {state?.ready ? state.files.toLocaleString("en") : "24,252"} files
          </span>
        </div>
        <div className="header-actions">
          {state?.ready && (
            <details className="branch-menu" ref={branchMenu}>
              <summary>
                ⑂ <span>{state.branch}</span> <span className="subtle">⌄</span>
              </summary>
              <div className="branch-options">
                {state.branches.map((branch) => (
                  <button
                    type="button"
                    key={branch}
                    disabled={busy || branch === state.branch}
                    onClick={() => {
                      if (branchMenu.current !== null) branchMenu.current.open = false;
                      void workspace.mutate({ action: "checkout", branch }, "Switching branch");
                    }}
                  >
                    <span>⑂</span> {branch}
                    {branch === state.branch ? " ✓" : ""}
                  </button>
                ))}
              </div>
            </details>
          )}
          <span className="runtime-label">
            <span className="status-light" /> LOCAL WORKERD
          </span>
        </div>
      </header>

      {workspace.error !== "" && (
        <div className="error-banner" role="alert">
          <span>{workspace.error}</span>
          <button type="button" className="quiet" onClick={() => workspace.setError("")}>
            Dismiss
          </button>
        </div>
      )}

      {state?.ready ? (
        <div className="workbench">
          <Explorer
            revision={state.filesystemRevision}
            selected={file?.path ?? ""}
            disabled={busy}
            open={open}
            onError={workspace.setError}
          />
          <div className="editor-column">
            <section className="editor-panel" aria-label="Source editor">
              <div className="editor-tabbar">
                <span className="editor-tab">
                  {file?.path.split("/").at(-1) ?? "No file open"}
                  {workspace.dirty && (
                    <span className="dirty-dot" title="Unsaved changes">
                      ●
                    </span>
                  )}
                </span>
                <div className="editor-actions">
                  <button
                    type="button"
                    className="quiet"
                    disabled={busy || file === undefined}
                    onClick={workspace.reload}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    className="save-button"
                    disabled={busy || !workspace.dirty || workspace.conflict}
                    onClick={() => void workspace.save()}
                  >
                    Save <kbd>⌘/Ctrl S</kbd>
                  </button>
                </div>
              </div>
              <div className="breadcrumbs">
                <span>next.js</span> / {file?.path ?? "Select a file"}
                <span className="buffer-status">
                  {workspace.dirty ? "Unsaved" : "Saved to SQLite"}
                </span>
              </div>
              {workspace.conflict && (
                <div className="conflict-banner">
                  The file changed on the server. Your draft is preserved. Copy it, then reload to
                  reconcile.
                </div>
              )}
              {file === undefined ? (
                <div className="editor-empty">Open a file from the explorer or search.</div>
              ) : (
                <Editor
                  key={file.path}
                  path={file.path}
                  text={workspace.text}
                  disabled={busy}
                  query={query}
                  onChange={workspace.setText}
                  onSave={() => {
                    if (!busy && workspace.dirty && !workspace.conflict) void workspace.save();
                  }}
                />
              )}
            </section>
            <Terminal initialCwd={state.cwd} disabled={busy} run={workspace.runShell} />
          </div>
          <Inspector
            tab={tab}
            setTab={setTab}
            state={state}
            revision={workspace.revision}
            disabled={busy}
            open={open}
            stage={(path) => void workspace.mutate({ action: "stage", path }, "Staging file")}
            commit={(message) =>
              void workspace.mutate({ action: "commit", message }, "Committing changes")
            }
            onError={workspace.setError}
            onMeasure={workspace.setMeasurement}
          />
        </div>
      ) : (
        <section className="welcome">
          <div className="welcome-label">A REAL REPOSITORY. ONE SQLITE DATABASE.</div>
          <h1>
            24,252 files.
            <br />
            Make yourself at home.
          </h1>
          <p>
            Browse the Next.js source, edit a file, search the entire tree.
            <br />
            Then commit it — from the editor or the terminal.
          </p>
          <button
            type="button"
            className="accent-button clone-button"
            disabled={busy || state === undefined}
            onClick={() => void workspace.clone()}
          >
            {busy ? workspace.pending : "Clone Next.js into the workspace"}
            <span>→</span>
          </button>
          <div className="welcome-details">
            Next.js v15.5.2 · full tree from a local Smart HTTP origin
            <br />
            Filesystem + Git + shell · SQLite Durable Object · local workerd
          </div>
        </section>
      )}

      <footer className="statusbar">
        <span className="storage-signature">
          <span className="status-light" /> Files + Git → SQLite{" "}
          <span className="subtle">/ one Durable Object</span>
        </span>
        <span className="operation-status" aria-live="polite">
          {busy ? (
            workspace.pending
          ) : workspace.measurement === undefined ? (
            "Ready"
          ) : (
            <>
              <span>{workspace.measurement.action}</span>{" "}
              {workspace.measurement.milliseconds.toFixed(0)} ms round trip{" "}
              <span className="metric-separator">·</span> {workspace.measurement.statements} SQL{" "}
              <span className="metric-separator">·</span>{" "}
              {workspace.measurement.rowsReturned.toLocaleString("en")} rows returned
            </>
          )}
        </span>
        <span className="subtle">UTF-8</span>
      </footer>
    </main>
  );
}
