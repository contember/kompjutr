import { useEffect, useState } from "react";
import {
  type ChangedFile,
  type ChangeList,
  changesSchema,
  diffSchema,
} from "../shared/protocol.js";
import { type Measurement, request } from "./api.js";
import { PatchView } from "./patch-view.js";

export interface RevisionTarget {
  ref: string;
  path: string;
}

interface Props {
  from: string;
  to: string;
  disabled: boolean;
  openRevision(target: RevisionTarget): void;
  onError(message: string): void;
  onMeasure(measurement: Measurement): void;
}

function fileLabel(file: ChangedFile): string {
  return file.originalPath === undefined ? file.path : `${file.originalPath} → ${file.path}`;
}

function patchPaths(file: ChangedFile): string[] {
  return file.originalPath === undefined ? [file.path] : [file.originalPath, file.path];
}

export function ChangeSet({ from, to, disabled, openRevision, onError, onMeasure }: Props) {
  const [list, setList] = useState<ChangeList & { from: string; to: string }>();
  const [selected, setSelected] = useState<ChangedFile>();
  const [patch, setPatch] = useState<{ text: string; file: ChangedFile }>();
  const current = list?.from === from && list.to === to ? list : undefined;

  useEffect(() => {
    let cancelled = false;
    setSelected(undefined);
    void request({ action: "changes", from, to }, changesSchema)
      .then((result) => {
        if (cancelled) return;
        setList({ ...result.data, from, to });
        onMeasure(result.measurement);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, onError, onMeasure]);

  useEffect(() => {
    if (selected === undefined) return;
    let cancelled = false;
    void request({ action: "patch", from, to, paths: patchPaths(selected) }, diffSchema)
      .then((result) => {
        if (cancelled) return;
        setPatch({ text: result.data.patch, file: selected });
        onMeasure(result.measurement);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, selected, onError, onMeasure]);

  if (current === undefined) return <div className="empty-state">Loading changed files…</div>;
  return (
    <>
      <div className="section-label">
        {current.total === current.files.length
          ? `${current.total} CHANGED FILES`
          : `SHOWING ${current.files.length} OF ${current.total.toLocaleString("en")} CHANGED FILES`}
      </div>
      <div className="changes-list">
        {current.total === 0 && <div className="empty-state">No file changes.</div>}
        {current.files.map((file) => (
          <div
            key={file.path}
            className={`change-row ${selected?.path === file.path ? "selected" : ""}`}
          >
            <button
              type="button"
              className="change-path"
              title={fileLabel(file)}
              disabled={disabled}
              onClick={() => setSelected(file)}
            >
              <span className="change-code">{file.status}</span>
              {fileLabel(file)}
            </button>
            <span className="change-stats">
              <span className="added">+{file.insertions}</span>{" "}
              <span className="removed">−{file.deletions}</span>
            </span>
            <button
              type="button"
              className="quiet"
              disabled={disabled}
              aria-label={`View ${file.path} at this revision`}
              title={file.status === "D" ? "View before deletion" : "View at this revision"}
              onClick={() =>
                openRevision(
                  file.status === "D"
                    ? { ref: from, path: file.path }
                    : { ref: to, path: file.path },
                )
              }
            >
              ↗
            </button>
          </div>
        ))}
      </div>
      {selected !== undefined && (
        <>
          <div className="diff-heading">
            <span title={selected.path}>{selected.path.split("/").at(-1)}</span>
            <code>
              {from.slice(0, 8)}..{to.slice(0, 8)}
            </code>
          </div>
          {patch?.file !== selected ? (
            <div className="empty-state">Loading patch…</div>
          ) : (
            <PatchView patch={patch.text} />
          )}
        </>
      )}
    </>
  );
}
