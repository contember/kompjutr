import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiRequest,
  type FileDocument,
  fileSchema,
  okSchema,
  type ShellResult,
  shellSchema,
  stateSchema,
  type WorkspaceState,
} from "../shared/protocol.js";
import { ApiError, type Measurement, request } from "./api.js";

const START_FILE = "packages/next/src/server/web/spec-extension/request.ts";

export function useWorkspace() {
  const [state, setState] = useState<WorkspaceState>();
  const [document, setDocument] = useState<FileDocument>();
  const [text, setText] = useState("");
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const [revision, setRevision] = useState(0);
  const [measurement, setMeasurement] = useState<Measurement>();
  const active = useRef(false);
  const buffer = useRef({ document, text });
  buffer.current = { document, text };

  const replaceDocument = useCallback((next: FileDocument) => {
    buffer.current = { document: next, text: next.text };
    setDocument(next);
    setText(next.text);
    setConflict(false);
  }, []);

  const task = useCallback(async <T>(label: string, run: () => Promise<T>) => {
    if (active.current) return undefined;
    active.current = true;
    setPending(label);
    setError("");
    try {
      return await run();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return undefined;
    } finally {
      active.current = false;
      setPending("");
    }
  }, []);

  const refresh = useCallback(async () => {
    const result = await request({ action: "state" }, stateSchema);
    setState(result.data);
    setRevision((value) => value + 1);
    const current = buffer.current;
    if (current.document === undefined) return;
    const dirty = current.text !== current.document.text;
    try {
      const next = await request({ action: "file", path: current.document.path }, fileSchema);
      if (dirty) {
        setConflict(next.data.version !== current.document.version);
      } else {
        replaceDocument(next.data);
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === "ENOENT") {
        if (dirty) setConflict(true);
        else {
          setDocument(undefined);
          setText("");
        }
      } else {
        throw failure;
      }
    }
  }, [replaceDocument]);

  useEffect(() => {
    void task("Opening workspace", async () => {
      const result = await request({ action: "state" }, stateSchema);
      setState(result.data);
      setMeasurement(result.measurement);
      if (result.data.ready) {
        const file = await request({ action: "file", path: START_FILE }, fileSchema);
        replaceDocument(file.data);
      }
    });
  }, [task, replaceDocument]);

  const clone = () =>
    task("Cloning 24,252 files into SQLite", async () => {
      const result = await request({ action: "clone" }, stateSchema);
      setState(result.data);
      setRevision((value) => value + 1);
      const file = await request({ action: "file", path: START_FILE }, fileSchema);
      replaceDocument(file.data);
      setMeasurement(result.measurement);
    });

  const open = (path: string) =>
    task("Opening file", async () => {
      const current = buffer.current;
      if (current.document?.path === path) return;
      if (current.document !== undefined && current.text !== current.document.text) {
        throw new Error("Save or reload the current file before opening another one.");
      }
      const result = await request({ action: "file", path }, fileSchema);
      replaceDocument(result.data);
      setMeasurement(result.measurement);
    });

  const save = () =>
    task("Saving file", async () => {
      const current = buffer.current;
      if (current.document === undefined) return;
      const result = await request(
        {
          action: "save",
          path: current.document.path,
          text: current.text,
          version: current.document.version,
        },
        fileSchema,
      );
      replaceDocument(result.data);
      await refresh();
      setMeasurement(result.measurement);
    });

  const reload = () => {
    const current = buffer.current;
    if (current.document === undefined) return;
    if (
      current.text !== current.document.text &&
      !window.confirm("Discard unsaved editor changes?")
    ) {
      return;
    }
    void task("Reloading file", async () => {
      if (current.document === undefined) return;
      const result = await request({ action: "file", path: current.document.path }, fileSchema);
      replaceDocument(result.data);
      setMeasurement(result.measurement);
    });
  };

  const mutate = (input: ApiRequest, label: string) =>
    task(label, async () => {
      if (input.action === "checkout" && buffer.current.document !== undefined) {
        if (buffer.current.text !== buffer.current.document.text) {
          throw new Error("Save or reload the current file before switching branches.");
        }
      }
      const result = await request(input, okSchema);
      await refresh();
      setMeasurement(result.measurement);
      return result.data;
    });

  const runShell = (source: string, publish: (result: ShellResult) => void) =>
    task("Running command", async () => {
      const result = await request({ action: "shell", source }, shellSchema);
      publish(result.data);
      setMeasurement(result.measurement);
      try {
        await refresh();
      } catch (failure) {
        setError(
          `Command finished; refresh failed: ${failure instanceof Error ? failure.message : String(failure)}`,
        );
      }
      return result.data;
    });

  return {
    state,
    document,
    text,
    setText,
    dirty: document !== undefined && document.text !== text,
    conflict,
    error,
    setError,
    pending,
    revision,
    measurement,
    setMeasurement,
    clone,
    open,
    save,
    reload,
    mutate,
    runShell,
  };
}
