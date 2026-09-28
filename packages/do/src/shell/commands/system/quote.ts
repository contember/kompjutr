// uutils quotes a file name in some diagnostics only when a shell would need
// it (the `os_display` crate's `maybe_quote`): `'a b'`, `"a'b"`, `-a`.

const SPECIAL = new Set(Array.from("|&;<>()$`\\\"'*?[=^! \t\n"));
const SPECIAL_AT_START = new Set(["~", "#"]);
const DOUBLE_QUOTE_UNSAFE = /[$`\\"]/;

export function maybeQuote(name: string): string {
  const first = name.charAt(0);
  const plain =
    name !== "" &&
    !SPECIAL_AT_START.has(first) &&
    !Array.from(name).some((char) => SPECIAL.has(char) || isControl(char));
  if (plain) return name;
  if (Array.from(name).some(isControl)) return withControls(name);
  if (name.includes("'") && !DOUBLE_QUOTE_UNSAFE.test(name)) return `"${name}"`;
  return `'${name.replaceAll("'", "'\\''")}'`;
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** Printable runs in single quotes, each control character as `$'\t'`. */
function withControls(name: string): string {
  let out = "";
  let run = "";
  for (const char of name) {
    if (!isControl(char)) {
      run += char;
      continue;
    }
    if (run !== "") out += `'${run.replaceAll("'", "'\\''")}'`;
    run = "";
    out += `$'${controlEscape(char)}'`;
  }
  if (run !== "") out += `'${run.replaceAll("'", "'\\''")}'`;
  return out;
}

function controlEscape(char: string): string {
  if (char === "\t") return "\\t";
  if (char === "\n") return "\\n";
  if (char === "\r") return "\\r";
  return `\\x${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}
