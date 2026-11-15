// SPDX-License-Identifier: Apache-2.0
// Speaker notes: a small, hand-written Markdown subset to HTML renderer for the trusted interface (presenter
// view). Pure function, no DOM, no dependencies, linear time.
//
// Output allowlist (and nothing else, ever): p, br, strong, em, code, pre, ul, ol (with an integer `start`), li,
// h3, h4, blockquote. No other attribute, no inline style, no URL. Every character of the input that is not
// Markdown syntax is HTML-escaped, so raw HTML, entities, links and images come out as visible text.
//
// Supported:
//   paragraphs (every line break inside a paragraph is kept as <br>)   **bold**   *italic*   `code`
//   ``` or ~~~ fenced code blocks   - * + bullets and 1. 1) numbers, nested one level (indent 2+ spaces)
//   # heading (h3), ## and deeper (h4)   > blockquote (one level; may hold paragraphs, lists, code)
//   backslash escapes of ASCII punctuation (\* shows a star)
// Not rendered, shown as text: links, images, autolinks, raw HTML, tables, rules, setext headings, underscores.
// Inline formatting does not span lines.

/** Longer input is cut here (the schema allows 16 KB of notes) and marked with an ellipsis. */
export const NOTES_MAX_INPUT = 64 * 1024;

/** Tags the renderer can emit. `ol` may carry `start` (digits only); no other attribute exists. */
export const NOTES_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "h3",
  "h4",
  "blockquote",
] as const;

/** Maximum nesting of emphasis (`**` inside `*` inside `**`...). Deeper markers stay literal. */
const MAX_EMPHASIS_DEPTH = 4;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? "");
}

const PUNCT = /^[!-/:-@[-`{-~]$/;
const isSpace = (ch: string | undefined): boolean =>
  ch === undefined || ch === " " || ch === "\t" || ch === " ";

// ---------------------------------------------------------------------------------------------------------------
// Inline

interface Frame {
  /** Length of the opening delimiter (1 = em, 2 = strong); 0 for the root. */
  len: number;
  parts: string[];
}

/** Emphasis over a code-free segment: a delimiter stack with per-kind opener lists, linear time. */
function emphasis(text: string): string {
  const stack: Frame[] = [{ len: 0, parts: [] }];
  const openers: Record<number, number[]> = { 1: [], 2: [] };
  const top = (): Frame => stack[stack.length - 1] as Frame;
  /** Pops the top frame back into its parent as literal text. */
  const collapse = (): void => {
    const f = stack.pop() as Frame;
    const list = openers[f.len] as number[];
    if (list[list.length - 1] === stack.length) list.pop();
    top().parts.push("*".repeat(f.len), f.parts.join(""));
  };
  let plain = "";
  const flush = (): void => {
    if (plain !== "") top().parts.push(escape(plain));
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1] as string)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch !== "*") {
      plain += ch;
      i += 1;
      continue;
    }
    let run = 0;
    while (text[i + run] === "*") run += 1;
    const before = text[i - 1];
    const after = text[i + run];
    const canOpen = !isSpace(after);
    const canClose = i > 0 && !isSpace(before);
    flush();
    // A run of stars is split into `**` pairs, plus a single `*` if the run is odd.
    let left = run;
    while (left > 0) {
      const len = left >= 2 ? 2 : 1;
      left -= len;
      const list = openers[len] as number[];
      const opener = list[list.length - 1];
      if (canClose && opener !== undefined) {
        while (stack.length - 1 > opener) collapse();
        const f = stack.pop() as Frame;
        list.pop();
        const inner = f.parts.join("");
        const tag = len === 2 ? "strong" : "em";
        top().parts.push(inner === "" ? "*".repeat(len * 2) : `<${tag}>${inner}</${tag}>`);
      } else if (canOpen && stack.length <= MAX_EMPHASIS_DEPTH) {
        stack.push({ len, parts: [] });
        list.push(stack.length - 1);
      } else {
        top().parts.push("*".repeat(len));
      }
    }
    i += run;
  }
  flush();
  while (stack.length > 1) collapse();
  return top().parts.join("");
}

/** Inline formatting of one line: code spans first (backtick runs of equal length), then emphasis. */
export function renderInline(text: string): string {
  // Backtick runs, and for each the index of the next run with the same length (computed right to left).
  const runs: { at: number; len: number }[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let len = 0;
    while (text[i + len] === "`") len += 1;
    runs.push({ at: i, len });
    i += len;
  }
  const nextSame = new Array<number>(runs.length).fill(-1);
  const seen = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k--) {
    const r = runs[k] as { at: number; len: number };
    nextSame[k] = seen.get(r.len) ?? -1;
    seen.set(r.len, k);
  }
  let out = "";
  let cursor = 0;
  for (let k = 0; k < runs.length; ) {
    const r = runs[k] as { at: number; len: number };
    const j = nextSame[k] as number;
    if (j === -1 || r.at < cursor) {
      k += 1;
      continue;
    }
    const close = runs[j] as { at: number; len: number };
    let code = text.slice(r.at + r.len, close.at);
    if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") {
      code = code.slice(1, -1);
    }
    out += `${emphasis(text.slice(cursor, r.at))}<code>${escape(code)}</code>`;
    cursor = close.at + close.len;
    k = j + 1;
  }
  return out + emphasis(text.slice(cursor));
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( *)([-*+]|[0-9]{1,9}[.)])[ \t]+(.*)$/;

interface Item {
  indent: number;
  ordered: boolean;
  /** The number of an ordered item. */
  start: number;
  text: string;
}

function itemOf(line: string): Item | null {
  const m = ITEM.exec(line.replace(/\t/g, "    "));
  if (!m) return null;
  const marker = m[2] as string;
  const ordered = marker.length > 1 || /[0-9]/.test(marker);
  return {
    indent: (m[1] as string).length,
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    text: m[3] as string,
  };
}

const isBlank = (line: string): boolean => line.trim() === "";

function startsBlock(line: string, quotes: boolean): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    (quotes && QUOTE.test(line)) ||
    (itemOf(line)?.indent ?? 4) <= 3
  );
}

/** Lines joined by <br>, each with inline formatting. */
const lines = (texts: string[]): string => texts.map((t) => renderInline(t.trim())).join("<br>");

function openList(item: Item): string {
  if (!item.ordered) return "<ul>";
  return item.start === 1 ? "<ol>" : `<ol start="${item.start}">`;
}

/** A list starting at `lines[i]`; returns the HTML and the index after it. */
function list(src: string[], from: number): [string, number] {
  const first = itemOf(src[from] as string) as Item;
  const base = first.indent;
  let html = openList(first);
  // Open top item: its text lines, and its nested lists already rendered.
  let itemText: string[] | null = null;
  let nested = "";
  let sub: { ordered: boolean; texts: string[][] } | null = null;
  const closeSub = (): void => {
    if (!sub) return;
    const tag = sub.ordered ? "ol" : "ul";
    nested += `<${tag}>${sub.texts.map((t) => `<li>${lines(t)}</li>`).join("")}</${tag}>`;
    sub = null;
  };
  const closeItem = (): void => {
    closeSub();
    if (itemText) html += `<li>${lines(itemText)}${nested}</li>`;
    itemText = null;
    nested = "";
  };
  let i = from;
  while (i < src.length) {
    const line = src[i] as string;
    if (isBlank(line)) {
      // A blank line continues the list only if the next line is an item or indented continuation.
      let j = i + 1;
      while (j < src.length && isBlank(src[j] as string)) j += 1;
      const next = src[j];
      const item = next === undefined ? null : itemOf(next);
      const continues =
        next !== undefined &&
        ((item !== null && (item.indent >= base + 2 || item.ordered === first.ordered)) ||
          (item === null && /^ {2,}\S/.test(next)));
      if (!continues) break;
      i = j;
      continue;
    }
    const item = itemOf(line);
    if (item && item.indent < base + 2 && item.indent <= 3) {
      if (item.ordered !== first.ordered) break;
      closeItem();
      itemText = [item.text];
    } else if (item && itemText) {
      // Nested (deeper levels are flattened to this one).
      const current = sub as { ordered: boolean; texts: string[][] } | null;
      if (current && current.ordered !== item.ordered) closeSub();
      if (!sub) sub = { ordered: item.ordered, texts: [] };
      (sub as { texts: string[][] }).texts.push([item.text]);
    } else if (/^ {2,}\S/.test(line.replace(/\t/g, "    ")) && itemText) {
      // Continuation of the last item (nested or top level).
      const s = sub as { texts: string[][] } | null;
      const last = s?.texts[s.texts.length - 1];
      if (last) last.push(line);
      else (itemText as string[]).push(line);
    } else {
      break;
    }
    i += 1;
  }
  closeItem();
  return [`${html}${first.ordered ? "</ol>" : "</ul>"}`, i];
}

function blocks(src: string[], quotes: boolean): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const line = src[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1] as string;
      const body: string[] = [];
      i += 1;
      while (i < src.length) {
        const l = src[i] as string;
        const t = l.trimStart();
        if (
          l.length - t.length <= 3 &&
          t.startsWith(mark) &&
          t
            .slice(mark.length)
            .replace(new RegExp(`^\\${mark[0]}*`), "")
            .trim() === ""
        ) {
          i += 1;
          break;
        }
        body.push(l);
        i += 1;
      }
      out += `<pre><code>${escape(body.join("\n"))}</code></pre>`;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      let text = line.slice(heading[0].length).trim();
      // Optional closing #s, if separated by a space (or the whole text).
      let end = text.length;
      while (end > 0 && text[end - 1] === "#") end -= 1;
      if (end === 0 || isSpace(text[end - 1])) text = text.slice(0, end).trim();
      const tag = (heading[1] as string).length === 1 ? "h3" : "h4";
      out += `<${tag}>${renderInline(text)}</${tag}>`;
      i += 1;
      continue;
    }
    if (quotes && QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < src.length && QUOTE.test(src[i] as string)) {
        inner.push((src[i] as string).replace(/^ {0,3}> ?/, ""));
        i += 1;
      }
      out += `<blockquote>${blocks(inner, false)}</blockquote>`;
      continue;
    }
    if ((itemOf(line)?.indent ?? 4) <= 3) {
      const [html, next] = list(src, i);
      out += html;
      i = next;
      continue;
    }
    const para: string[] = [];
    while (i < src.length) {
      const l = src[i] as string;
      if (isBlank(l) || (para.length > 0 && startsBlock(l, quotes))) break;
      para.push(l);
      i += 1;
    }
    out += `<p>${lines(para)}</p>`;
  }
  return out;
}

/**
 * Renders speaker notes (Markdown subset) to safe HTML for the trusted interface. Never throws for string input;
 * anything that is not a string renders as an empty string.
 */
export function renderNotes(markdown: unknown): string {
  if (typeof markdown !== "string" || markdown === "") return "";
  let text = markdown;
  if (text.length > NOTES_MAX_INPUT) text = `${text.slice(0, NOTES_MAX_INPUT)}…`;
  // Normalize line endings and drop characters that have no business in HTML text.
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
  return blocks(text.split("\n"), true);
}
