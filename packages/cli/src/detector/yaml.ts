// Zero-dependency, best-effort YAML frontmatter parser.
//
// Handles the subset that Claude Code SKILL.md / agent frontmatter uses in the
// wild: flat scalars, one level of nested maps (e.g. telnyx `metadata.product`),
// folded/literal block scalars (`description: >-`), and block/flow lists
// (`tags:`). It is intentionally NOT a full YAML implementation — anything more
// exotic is skipped rather than throwing.

export function extractFrontmatter(fileContent: string): Record<string, unknown> | null {
  // Normalize CRLF/CR → LF so Windows/autocrlf-authored files parse identically.
  const text = fileContent.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  if (match === null) {
    return null;
  }
  const body = match[1];
  if (body === undefined) {
    return null;
  }
  return parseYamlFrontmatter(body);
}

export function parseYamlFrontmatter(body: string): Record<string, unknown> {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    if (leadingSpaces(line) > 0) {
      // Stray over-indented line at the top scope (e.g. dangling block content) — skip.
      i++;
      continue;
    }
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (isBlockScalarIndicator(rawValue)) {
      const { value, next } = collectBlockScalar(lines, i + 1, 0, rawValue);
      out[key] = value;
      i = next;
      continue;
    }
    if (rawValue === "") {
      const { value, next } = collectNested(lines, i + 1, 0);
      out[key] = value;
      i = next;
      continue;
    }
    // Inline scalar — fold any indented continuation lines (plain multi-line scalar).
    const cont = collectPlainContinuation(lines, i + 1);
    if (cont.lines.length > 0) {
      out[key] = [rawValue, ...cont.lines].join(" ");
      i = cont.next;
    } else {
      out[key] = coerceYamlValue(rawValue);
      i++;
    }
  }
  return out;
}

function collectPlainContinuation(
  lines: readonly string[],
  start: number,
): { lines: string[]; next: number } {
  const collected: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || leadingSpaces(line) === 0) {
      break;
    }
    collected.push(line.trim());
  }
  return { lines: collected, next: i };
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " " || ch === "\t") {
      n++;
    } else {
      break;
    }
  }
  return n;
}

function isBlockScalarIndicator(raw: string): boolean {
  return (
    raw === ">" || raw === ">-" || raw === ">+" || raw === "|" || raw === "|-" || raw === "|+"
  );
}

function collectBlockScalar(
  lines: readonly string[],
  start: number,
  baseIndent: number,
  indicator: string,
): { value: string; next: number } {
  const folded = indicator.startsWith(">");
  const content: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      content.push("");
      continue;
    }
    if (leadingSpaces(line) <= baseIndent) {
      break;
    }
    content.push(line.trim());
  }
  while (content.length > 0 && content[content.length - 1] === "") {
    content.pop();
  }
  return { value: folded ? content.join(" ").trim() : content.join("\n"), next: i };
}

function collectNested(
  lines: readonly string[],
  start: number,
  baseIndent: number,
): { value: unknown; next: number } {
  let peek = start;
  while (peek < lines.length && (lines[peek] ?? "").trim() === "") {
    peek++;
  }
  if (peek >= lines.length) {
    return { value: null, next: start };
  }
  const firstLine = lines[peek] ?? "";
  if (leadingSpaces(firstLine) <= baseIndent) {
    return { value: null, next: start };
  }
  const firstTrimmed = firstLine.trim();

  if (firstTrimmed === "-" || firstTrimmed.startsWith("- ")) {
    const arr: unknown[] = [];
    let i = start;
    for (; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.trim() === "") {
        continue;
      }
      if (leadingSpaces(line) <= baseIndent) {
        break;
      }
      const t = line.trim();
      if (t === "-") {
        arr.push(null);
      } else if (t.startsWith("- ")) {
        arr.push(coerceYamlValue(t.slice(2).trim()));
      }
    }
    return { value: arr, next: i };
  }

  const map: Record<string, unknown> = {};
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (t === "" || t.startsWith("#")) {
      continue;
    }
    if (leadingSpaces(line) <= baseIndent) {
      break;
    }
    const ci = t.indexOf(":");
    if (ci === -1) {
      continue;
    }
    const k = t.slice(0, ci).trim();
    const val = t.slice(ci + 1).trim();
    map[k] = val === "" || isBlockScalarIndicator(val) ? null : coerceYamlValue(val);
  }
  return { value: map, next: i };
}

function coerceYamlValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowList(inner).map((s) => coerceYamlValue(s.trim()));
  }
  return raw;
}

/** Split a flow-list body on commas, ignoring commas inside single/double quotes. */
function splitFlowList(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}
