import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, hoverTooltip, type ViewUpdate } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { native, type LspDiagnostic } from "@/modules/ai/lib/native";
import { requestOpenFile } from "@/lib/openFileRequests";
import { languageIdForPath } from "./paths";
import { normalizeRoot, recordFileProblems } from "./store";

// Typing should not put a request on the wire per keystroke; this is the pause
// after which the buffer is worth re-checking.
const CHANGE_DEBOUNCE_MS = 400;

export type LspContext = {
  getPath: () => string;
  /** Project root, or null once the project is no longer enabled. */
  getRoot: () => string | null;
};

/** LSP positions are zero-based line + UTF-16 offset; CodeMirror lines are 1-based. */
function toOffset(state: EditorState, line: number, character: number): number {
  const target = Math.min(Math.max(line, 0) + 1, state.doc.lines);
  const lineObj = state.doc.line(target);
  return Math.min(lineObj.from + Math.max(character, 0), lineObj.to);
}

function toPosition(state: EditorState, offset: number): { line: number; character: number } {
  const lineObj = state.doc.lineAt(offset);
  return { line: lineObj.number - 1, character: offset - lineObj.from };
}

function severityOf(diagnostic: LspDiagnostic): Diagnostic["severity"] {
  if (diagnostic.severity === 1) return "error";
  if (diagnostic.severity === 2) return "warning";
  return "info";
}

export function toCodeMirrorDiagnostics(
  state: EditorState,
  diagnostics: LspDiagnostic[],
): Diagnostic[] {
  return diagnostics.map((d) => {
    const from = toOffset(state, d.startLine, d.startCharacter);
    const rawTo = toOffset(state, d.endLine, d.endCharacter);
    // A zero-width range renders as nothing; widen it to the character after so
    // there is always something to underline and hover.
    const to = rawTo > from ? rawTo : Math.min(from + 1, state.doc.length);
    return {
      from,
      to,
      severity: severityOf(d),
      source: d.code ? `ts(${d.code})` : (d.source ?? "ts"),
      message: d.message,
    };
  });
}

async function pullDiagnostics(view: EditorView, context: LspContext): Promise<void> {
  const root = context.getRoot();
  const path = context.getPath();
  if (!root) return;
  try {
    const diagnostics = await native.lspDiagnostics(root, path);
    // The pane may have switched files while the request was in flight.
    if (context.getPath() !== path) return;
    recordFileProblems(root, path, diagnostics);
    view.dispatch(setDiagnostics(view.state, toCodeMirrorDiagnostics(view.state, diagnostics)));
  } catch {
    // A server that died or a file it does not own: leave the last marks be
    // rather than flashing the gutter empty.
  }
}

/**
 * Wires one editor view to the language server for its project: keeps the
 * server's copy of the buffer current, refreshes diagnostics, and answers
 * ctrl/cmd+click with go-to-definition.
 */
export function lspExtension(context: LspContext): Extension {
  const sync = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private unlisten: (() => void) | null = null;
      private disposed = false;

      constructor(readonly view: EditorView) {
        void pullDiagnostics(view, context);
        // The server asks for a re-pull when something outside the buffer
        // changed its mind about this file, e.g. a dependency was installed.
        void listen<{ root: string }>("lsp:refresh", (event) => {
          const root = context.getRoot();
          if (!root || normalizeRoot(event.payload.root) !== root) return;
          void pullDiagnostics(view, context);
        }).then((fn) => {
          if (this.disposed) fn();
          else this.unlisten = fn;
        });
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.push();
        }, CHANGE_DEBOUNCE_MS);
      }

      async push() {
        const root = context.getRoot();
        const path = context.getPath();
        const languageId = languageIdForPath(path);
        if (!root || !languageId) return;
        try {
          await native.lspDidChange(root, path, this.view.state.doc.toString(), languageId);
        } catch {
          return;
        }
        if (context.getPath() !== path) return;
        await pullDiagnostics(this.view, context);
      }

      destroy() {
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.unlisten?.();
      }
    },
  );

  const gotoDefinition = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
      const root = context.getRoot();
      if (!root) return false;
      const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (offset == null) return false;

      const path = context.getPath();
      const { line, character } = toPosition(view.state, offset);
      event.preventDefault();
      void native
        .lspDefinition(root, path, line, character)
        .then((location) => {
          if (!location) return;
          requestOpenFile({
            path: location.path,
            line: location.line + 1,
            column: location.character + 1,
          });
        })
        .catch(() => {});
      return true;
    },
  });

  const hover = hoverTooltip(async (view, pos) => {
    const root = context.getRoot();
    if (!root) return null;
    const path = context.getPath();
    const { line, character } = toPosition(view.state, pos);
    const text = await native.lspHover(root, path, line, character).catch(() => null);
    if (!text || context.getPath() !== path) return null;
    return {
      pos,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-lsp-hover";
        dom.textContent = text;
        return { dom };
      },
    };
  });

  const hoverTheme = EditorView.baseTheme({
    ".cm-lsp-hover": {
      maxWidth: "480px",
      padding: "6px 8px",
      whiteSpace: "pre-wrap",
      fontSize: "12px",
      lineHeight: "1.45",
    },
  });

  return [sync, gotoDefinition, hover, hoverTheme];
}
