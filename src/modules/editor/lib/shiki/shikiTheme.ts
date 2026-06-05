import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import type { CustomEditorTheme } from "../../customEditorThemes";
import * as mgr from "./highlighterManager";

// Above this size we skip Shiki marks to keep editing responsive (the whole
// document is re-tokenized on each change to keep multi-line constructs — block
// comments, template strings — correct).
const MAX_SHIKI_CHARS = 200_000;

// Fired when the async highlighter/theme/language load finishes so the plugin
// can rebuild decorations (tokenize is synchronous once everything is cached).
const refreshShiki = StateEffect.define<null>();

function fontStyleCss(fs: number | undefined): string {
  if (!fs) return "";
  let s = "";
  if (fs & 1) s += "font-style:italic;";
  if (fs & 2) s += "font-weight:bold;";
  if (fs & 4) s += "text-decoration:underline;";
  return s;
}

function buildDecorations(
  view: EditorView,
  themeName: string,
  langId: string,
): DecorationSet {
  const text = view.state.doc.toString();
  if (text.length > MAX_SHIKI_CHARS) return Decoration.none;
  const tokens = mgr.tokenize(text, langId, themeName);
  if (!tokens) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const line of tokens) {
    for (const tk of line) {
      // Shiki `offset` is absolute within the full string, which matches the
      // CodeMirror document position exactly (both use \n separators).
      if (!tk.content || !tk.color) continue;
      if (!/\S/.test(tk.content)) continue; // skip whitespace-only spans
      const from = tk.offset;
      const to = from + tk.content.length;
      const style = `color:${tk.color};${fontStyleCss(tk.fontStyle)}`;
      builder.add(from, to, Decoration.mark({ attributes: { style } }));
    }
  }
  return builder.finish();
}

function makeHighlightPlugin(theme: CustomEditorTheme, langId: string) {
  const themeName = theme.id;
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        if (mgr.isReady(themeName, langId)) {
          this.decorations = buildDecorations(view, themeName, langId);
        } else {
          this.decorations = Decoration.none;
          void mgr.ensure(theme, langId).then(() => {
            try {
              view.dispatch({ effects: refreshShiki.of(null) });
            } catch {
              /* view torn down before load finished */
            }
          });
        }
      }
      update(u: ViewUpdate) {
        const refreshed = u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshShiki)),
        );
        if ((u.docChanged || refreshed) && mgr.isReady(themeName, langId)) {
          this.decorations = buildDecorations(u.view, themeName, langId);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

function luminanceIsDark(hex: string | undefined): boolean {
  if (!hex || hex[0] !== "#") return true;
  const h = hex.slice(1);
  const n =
    h.length >= 6
      ? [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)]
      : h.length >= 3
        ? [h[0] + h[0], h[1] + h[1], h[2] + h[2]]
        : null;
  if (!n) return true;
  const [r, g, b] = n.map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/** Build a CodeMirror extension that themes the editor chrome + applies Shiki
 *  syntax colors for an imported VSCode theme. Identity is stable per
 *  (theme.id, langId) via the cache in lib/themes.ts. */
export function shikiThemeExtension(
  theme: CustomEditorTheme,
  langId: string,
): Extension {
  const c = theme.rawJson.colors ?? {};
  const bg = c["editor.background"];
  const fg = c["editor.foreground"];
  const dark =
    theme.rawJson.type === "light"
      ? false
      : theme.rawJson.type === "dark"
        ? true
        : luminanceIsDark(bg);

  const fallbackBg = dark ? "#1e1e1e" : "#ffffff";
  const fallbackFg = dark ? "#d4d4d4" : "#1e1e1e";
  const editorBg = bg ?? fallbackBg;
  const editorFg = fg ?? fallbackFg;
  const cursor = c["editorCursor.foreground"] ?? editorFg;
  const selection =
    c["editor.selectionBackground"] ?? (dark ? "#264f78" : "#add6ff");
  const gutterBg = c["editorGutter.background"] ?? editorBg;
  const gutterFg = c["editorLineNumber.foreground"] ?? (dark ? "#858585" : "#237893");
  const gutterActiveFg = c["editorLineNumber.activeForeground"] ?? editorFg;
  const lineHighlight = c["editor.lineHighlightBackground"];

  const chrome = EditorView.theme(
    {
      "&": { color: editorFg, backgroundColor: editorBg },
      ".cm-content": { caretColor: cursor },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: selection },
      ".cm-gutters": {
        backgroundColor: gutterBg,
        color: gutterFg,
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: gutterActiveFg,
      },
      ".cm-activeLine": {
        backgroundColor: lineHighlight ?? "transparent",
      },
    },
    { dark },
  );

  return [chrome, makeHighlightPlugin(theme, langId)];
}
