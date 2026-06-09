// Zero-dependency, best-effort YAML frontmatter parser.
//
// Handles the subset that Claude Code SKILL.md / agent frontmatter uses in the
// wild: flat scalars, one level of nested maps (e.g. telnyx `metadata.product`),
// folded/literal block scalars (`description: >-`), and block/flow lists
// (`tags:`). It is intentionally NOT a full YAML implementation — anything more
// exotic is skipped rather than throwing.

export function extractFrontmatter(fileContent: string): Record<string, unknown> | null {
  // Strip a leading UTF-8 BOM, then normalize CRLF/CR → LF, so Windows/editor-authored
  // files (which may begin with U+FEFF) still match the byte-0 frontmatter fence rather
  // than being silently treated as having no frontmatter — which would drop the skill.
  const text = fileContent.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
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
  // Null prototype: frontmatter keys are untrusted, and `out["__proto__"] = v` on a
  // plain object would invoke the prototype setter — the key vanishes from own keys
  // and its map value becomes the prototype, leaking phantom name/description/metadata
  // through schema validation. With no prototype, `__proto__` is an ordinary own key.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
  // No indented content: the deleted v0.1.1 parser yielded "" for a bare `key:`,
  // which passed `description: v.string()` and kept the skill detected — preserve
  // that rather than returning null and silently dropping the file.
  if (peek >= lines.length) {
    return { value: "", next: start };
  }
  const firstLine = lines[peek] ?? "";
  if (leadingSpaces(firstLine) <= baseIndent) {
    return { value: "", next: start };
  }
  const firstTrimmed = firstLine.trim();
  const childIndent = leadingSpaces(firstLine);

  // A plain scalar whose value starts on the following line (legal YAML:
  // `description:\n  See https://docs… for details`): not a list item and no
  // mapping colon — fold it like a continuation rather than mis-reading it as a
  // map, which would fail schema validation and silently drop the skill/agent.
  // A colon only separates a mapping when followed by whitespace or end-of-line;
  // the ":" in a URL is part of the scalar.
  if (firstTrimmed !== "-" && !firstTrimmed.startsWith("- ") && mappingColonIndex(firstTrimmed) === -1) {
    const cont = collectPlainContinuation(lines, peek);
    return { value: cont.lines.join(" "), next: cont.next };
  }

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
      if (leadingSpaces(line) > childIndent) {
        continue; // deeper than the first item — nested content we don't model; skip, don't flatten
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

  // Null prototype for the same reason as the top-level accumulator: a nested
  // `__proto__:` key must become an ordinary own property, not a prototype swap.
  const map: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
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
    if (leadingSpaces(line) > childIndent) {
      continue; // grandchild of a one-level map — skip; flattening it would overwrite a real sibling key
    }
    const ci = mappingColonIndex(t);
    if (ci === -1) {
      continue;
    }
    const k = t.slice(0, ci).trim();
    const val = t.slice(ci + 1).trim();
    map[k] = val === "" || isBlockScalarIndicator(val) ? null : coerceYamlValue(val);
  }
  return { value: map, next: i };
}

/** Index of the first ":" that separates a mapping key (followed by space or EOL); -1 if none. */
function mappingColonIndex(line: string): number {
  for (let i = line.indexOf(":"); i !== -1; i = line.indexOf(":", i + 1)) {
    if (i === line.length - 1 || line[i + 1] === " " || line[i + 1] === "\t") {
      return i;
    }
  }
  return -1;
}

function coerceYamlValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/.test(raw)) {
    // Only coerce when the number round-trips back to the exact source text. A
    // zero-padded slug ("007") or an out-of-safe-range integer would otherwise be
    // silently corrupted (007→7, large ids lose precision past 2^53); keep those
    // as strings so the value survives intact.
    const n = Number(raw);
    return String(n) === raw ? n : raw;
  }
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
