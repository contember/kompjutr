import { StreamLanguage } from "@codemirror/language";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { editorTheme } from "./editor.js";

export function PatchView({ patch }: { patch: string }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (container.current === null) return;
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: patch,
        extensions: [
          editorTheme,
          oneDark,
          StreamLanguage.define(diff),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          EditorView.theme({ ".cm-scroller": { fontSize: "11px" } }),
          EditorView.contentAttributes.of({ "aria-label": "File diff" }),
        ],
      }),
    });
    return () => view.destroy();
  }, [patch]);
  return <div className="diff-content" ref={container} />;
}
