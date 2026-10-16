import { useEffect, useState } from "react";
import { blobSchema } from "../shared/protocol.js";
import { type Measurement, request } from "./api.js";
import type { RevisionTarget } from "./change-set.js";
import { Editor } from "./editor.js";

interface Props {
  target: RevisionTarget;
  onError(message: string): void;
  onMeasure(measurement: Measurement): void;
}

const ignore = () => {};

export function RevisionView({ target, onError, onMeasure }: Props) {
  const [blob, setBlob] = useState<{ text: string; target: RevisionTarget }>();
  const [failed, setFailed] = useState<RevisionTarget>();

  useEffect(() => {
    let cancelled = false;
    void request({ action: "blob", ref: target.ref, path: target.path }, blobSchema)
      .then((result) => {
        if (cancelled) return;
        setBlob({ text: result.data.text, target });
        onMeasure(result.measurement);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(target);
        onError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [target, onError, onMeasure]);

  if (blob?.target === target) {
    return (
      <Editor
        path={target.path}
        text={blob.text}
        disabled
        query=""
        onChange={ignore}
        onSave={ignore}
      />
    );
  }
  return (
    <div className="editor-empty">
      {failed === target ? "This revision cannot be shown in the editor." : "Loading revision…"}
    </div>
  );
}
