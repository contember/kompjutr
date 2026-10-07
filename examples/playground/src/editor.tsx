import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

function language(path: string): Extension {
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    return javascript({ typescript: /\.tsx?$/.test(path), jsx: /\.[jt]sx$/.test(path) });
  }
  if (path.endsWith(".json")) return json();
  if (path.endsWith(".css")) return css();
  if (path.endsWith(".md") || path.endsWith(".mdx")) return markdown();
  return [];
}

export const editorTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--workspace)", color: "var(--ink)" },
    ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.75" },
    ".cm-content": { padding: "16px 0", caretColor: "var(--signal)" },
    ".cm-gutters": {
      backgroundColor: "var(--workspace)",
      color: "var(--ink-muted)",
      border: "none",
      minWidth: "52px",
    },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--raised)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#33463b",
    },
    ".cm-cursor": { borderLeftColor: "var(--signal)" },
    ".cm-panels": { backgroundColor: "var(--raised)", color: "var(--ink)" },
    ".cm-searchMatch": { backgroundColor: "#6a593744" },
    ".cm-tooltip": { backgroundColor: "var(--raised)", border: "1px solid var(--seam)" },
  },
  { dark: true },
);

interface Props {
  path: string;
  text: string;
  disabled: boolean;
  query: string;
  onChange(text: string): void;
  onSave(): void;
}

export function Editor({ path, text, disabled, query, onChange, onSave }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const initial = useRef(text);
  const editable = useRef(new Compartment());

  useEffect(() => {
    if (container.current === null) return;
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          basicSetup,
          editorTheme,
          oneDark,
          language(path),
          EditorState.lineSeparator.of(initial.current.includes("\r\n") ? "\r\n" : "\n"),
          editable.current.of(EditorView.editable.of(true)),
          EditorView.contentAttributes.of({ "aria-label": `Editor: ${path}` }),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.sliceDoc());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => editor.destroy();
  }, [path]);

  useEffect(() => {
    const editor = view.current;
    if (editor !== undefined && editor.state.sliceDoc() !== text) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    }
  }, [text]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled]);

  useEffect(() => {
    const editor = view.current;
    if (editor === undefined || query === "") return;
    const offset = editor.state.doc.toString().indexOf(query);
    if (offset < 0) return;
    editor.dispatch({
      selection: { anchor: offset, head: offset + query.length },
      effects: EditorView.scrollIntoView(offset, { y: "center" }),
    });
  }, [query]);

  return <div className="editor" ref={container} />;
}
