// Rendering for `textDocument/hover` content.
//
// The server answers in markdown: a fenced block holding the signature,
// followed by the doc comment and its tags. A full markdown pipeline is far
// more than a tooltip needs, so this understands only the shapes a language
// server actually emits, and builds the DOM with textContent so nothing the
// server says can inject markup.

export type HoverSpan = { text: string; code: boolean };

export type HoverBlock =
  | { kind: "code"; text: string }
  | { kind: "text"; spans: HoverSpan[] };

const FENCE = /^```/;
// A horizontal rule is the separator between the signature and the docs; the
// layout already distinguishes them, so it renders as nothing.
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;

/** Splits inline `code` out of a paragraph and drops emphasis and link syntax. */
function toSpans(text: string): HoverSpan[] {
  const spans: HoverSpan[] = [];
  for (const [index, part] of text.split("`").entries()) {
    if (part === "") continue;
    // Odd indexes sit between backticks. An unterminated final run is prose.
    spans.push({ text: index % 2 === 1 ? part : plain(part), code: index % 2 === 1 });
  }
  return spans;
}

function plain(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2");
}

export function parseHoverMarkdown(markdown: string): HoverBlock[] {
  const blocks: HoverBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let paragraph: string[] = [];

  const flush = () => {
    const text = paragraph.join("\n").trim();
    paragraph = [];
    if (!text) return;
    const spans = toSpans(text);
    if (spans.length > 0) blocks.push({ kind: "text", spans });
  };

  for (let i = 0; i < lines.length; i++) {
    if (!FENCE.test(lines[i])) {
      if (RULE.test(lines[i].trim())) flush();
      else paragraph.push(lines[i]);
      continue;
    }
    flush();
    const body: string[] = [];
    i++;
    for (; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
    const text = body.join("\n").trim();
    if (text) blocks.push({ kind: "code", text });
  }
  flush();
  return blocks;
}

export function renderHoverContent(markdown: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "cm-lsp-hover";
  const blocks = parseHoverMarkdown(markdown);
  // A server that answered in plaintext yields one prose block; showing it in
  // the signature style is closer to right than wrapping it as a paragraph.
  if (blocks.length === 1 && blocks[0].kind === "text" && !markdown.includes("`")) {
    const code = document.createElement("div");
    code.className = "cm-lsp-hover-code";
    code.textContent = markdown.trim();
    root.append(code);
    return root;
  }
  for (const block of blocks) {
    if (block.kind === "code") {
      const code = document.createElement("div");
      code.className = "cm-lsp-hover-code";
      code.textContent = block.text;
      root.append(code);
      continue;
    }
    const p = document.createElement("div");
    p.className = "cm-lsp-hover-doc";
    for (const span of block.spans) {
      const node = document.createElement(span.code ? "code" : "span");
      node.textContent = span.text;
      p.append(node);
    }
    root.append(p);
  }
  return root;
}
