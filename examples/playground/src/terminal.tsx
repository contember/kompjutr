import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { Readline } from "xterm-readline";
import type { ShellResult } from "../shared/protocol.js";
import "@xterm/xterm/css/xterm.css";

interface Props {
  initialCwd: string;
  disabled: boolean;
  run(source: string, publish: (result: ShellResult) => void): Promise<ShellResult | undefined>;
}

export function Terminal({ initialCwd, disabled, run }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Xterm | undefined>(undefined);
  const callbacks = useRef({ initialCwd, disabled, run });
  callbacks.current = { initialCwd, disabled, run };

  useEffect(() => {
    if (container.current === null) return;
    const xterm = new Xterm({
      convertEol: true,
      cursorBlink: true,
      disableStdin: callbacks.current.disabled,
      screenReaderMode: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 3000,
      theme: { background: "#141917", foreground: "#d5dfd7", cursor: "#9ae6b4" },
    });
    const fit = new FitAddon();
    const readline = new Readline();
    xterm.loadAddon(fit);
    xterm.loadAddon(readline);
    xterm.open(container.current);
    xterm.textarea?.setAttribute("aria-label", "Terminal command");
    fit.fit();
    xterm.writeln("\x1b[38;2;154;230;180mkompjutr shell\x1b[0m  ·  files and Git in SQLite");
    for (const line of [
      "Bash-like subset with limited flags. No npm/Node or external processes.",
      "Files   pwd cd ls tree find cat head tail stat du",
      "Edit    touch mkdir cp mv rm rmdir ln chmod sed patch tee",
      "Text    rg grep awk jq sort uniq wc cut tr xargs echo printf",
      "Git     status diff add commit log show branch checkout switch restore",
      "Syntax  pipes | · && || ; · > >> < · quotes/globs · $VAR · $(...) · if/for",
      "Try     git status; git log --oneline -n 3",
      "        rg -n 'NextRequest' packages/next/src | head -10",
      "Keys    ↑/↓ history · ←/→ edit · Ctrl+C cancel input · Ctrl+L clear",
    ]) {
      xterm.writeln(line);
    }
    terminal.current = xterm;
    let disposed = false;
    let cwd = callbacks.current.initialCwd;

    async function readCommands() {
      while (!disposed) {
        const source = await readline.read(`\x1b[38;2;154;230;180m${cwd} $\x1b[0m `);
        if (disposed) return;
        if (source.trim() === "") continue;
        let endsWithNewline = true;
        const result = await callbacks.current.run(source, (output) => {
          if (disposed) return;
          cwd = output.cwd;
          xterm.write(output.stdout);
          if (output.stdout !== "") endsWithNewline = output.stdout.endsWith("\n");
          if (output.stderr !== "") {
            xterm.write(output.exitCode === 0 ? output.stderr : `\x1b[31m${output.stderr}\x1b[0m`);
            endsWithNewline = output.stderr.endsWith("\n");
          }
          if (output.exitCode !== 0 || output.truncated) {
            if (!endsWithNewline) xterm.write("\r\n");
            if (output.exitCode !== 0) xterm.writeln(`[exit ${output.exitCode}]`);
            if (output.truncated) xterm.writeln("[output limit reached]");
            endsWithNewline = true;
          }
        });
        if (disposed) return;
        if (!endsWithNewline) xterm.write("\r\n");
        if (result === undefined) {
          xterm.writeln("\x1b[31mRequest failed. See the error banner.\x1b[0m");
        }
      }
    }

    void readCommands();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container.current);
    return () => {
      disposed = true;
      observer.disconnect();
      xterm.dispose();
      terminal.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (terminal.current !== undefined) terminal.current.options.disableStdin = disabled;
  }, [disabled]);

  return (
    <section className="terminal-panel" aria-label="Terminal">
      <div className="panel-heading">
        <span>
          TERMINAL <span className="subtle">/ kompjutr shell</span>
        </span>
        <button
          type="button"
          className="quiet"
          disabled={disabled}
          onClick={() => {
            terminal.current?.input("\x0c");
            terminal.current?.focus();
          }}
        >
          Clear
        </button>
      </div>
      <div className="terminal-output" ref={container} />
    </section>
  );
}
