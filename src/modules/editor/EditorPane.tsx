import { redo, undo } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import { usePreferencesStore } from "@/modules/settings/preferences";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { getEditorThemeExtension } from "./lib/themes";
import { useCustomEditorThemesStore } from "./useCustomEditorThemesStore";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { MarkdownContent } from "@/modules/markdown";
import { Prec, type Extension } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import {
  buildSharedExtensions,
  languageCompartment,
  vimCompartment,
} from "./lib/extensions";
import { gitGutter, setGitBaseline } from "./lib/gitGutter";
import { native, type GitRepoInfo } from "@/modules/ai/lib/native";
import { listenFsChanged, parentDir } from "@/modules/explorer/lib/watch";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";

initVimGlobals();
import { resolveLanguage } from "./lib/languageResolver";
import { useDocument } from "./lib/useDocument";
import { inlineCompletion } from "./lib/autocomplete/inlineExtension";
import { getKey } from "@/modules/ai/lib/keyring";
import { onKeysChanged } from "@/modules/settings/store";
import { CASE_INSENSITIVE_FS } from "@/lib/platform";

// On Windows (and macOS) the filesystem is case-insensitive: the path git
// reports for the repo root and the path a tab carries can differ in
// drive-letter / segment casing, so paths must be compared case-folded.
function samePath(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/");
  const nb = b.replace(/\\/g, "/");
  return CASE_INSENSITIVE_FS ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// Resolving the repo for a file spawns git; cache per directory (promise, to
// dedup concurrent opens) so switching between files in a repo doesn't respawn.
const repoRootCache = new Map<string, Promise<GitRepoInfo | null>>();
function resolveRepoCached(dir: string): Promise<GitRepoInfo | null> {
  // Case-fold the cache key on a case-insensitive FS so C:\Foo and c:\foo share.
  const key = CASE_INSENSITIVE_FS ? dir.toLowerCase() : dir;
  const hit = repoRootCache.get(key);
  if (hit) return hit;
  const p = native.gitResolveRepo(dir).catch(() => null);
  repoRootCache.set(key, p);
  // Don't keep a negative result forever — a folder can become a repo (git
  // init) mid-session. The in-flight promise still dedups concurrent opens.
  void p.then((repo) => {
    if (!repo) repoRootCache.delete(key);
  });
  return p;
}

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  focus: () => void;
  /** Select and center the given 1-based line, buffering until the doc loads. */
  gotoLine: (line: number) => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
};

type Props = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const EditorPane = forwardRef<EditorPaneHandle, Props>(
  function EditorPane({ path, onDirtyChange, onSaved, onClose }, ref) {
    const { doc, onChange, save, reload } = useDocument({ path, onDirtyChange });
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    // A line requested before the view exists (file still loading) is buffered
    // here and flushed by `onCreateEditor` once CodeMirror mounts.
    const pendingLineRef = useRef<number | null>(null);

    const revealLine = useCallback((view: EditorView, line: number) => {
      const target = Math.max(1, Math.min(line, view.state.doc.lines));
      const lineObj = view.state.doc.line(target);
      view.dispatch({
        selection: { anchor: lineObj.from },
        effects: EditorView.scrollIntoView(lineObj.from, { y: "center" }),
      });
      view.focus();
    }, []);
    const editorThemeId = usePreferencesStore((s) => s.editorTheme);
    const customEditorThemes = useCustomEditorThemesStore((s) => s.customEditorThemes);
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const languageRef = useRef<string | null>(null);
    const apiKeyRef = useRef<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      const refresh = async () => {
        const provider = usePreferencesStore.getState().autocompleteProvider;
        if (provider === "lmstudio" || provider === "mlx" || provider === "ollama") {
          apiKeyRef.current = null;
          return;
        }
        const k = await getKey(provider);
        if (!cancelled) apiKeyRef.current = k;
      };
      void refresh();
      let unlistenKeys: (() => void) | undefined;
      void onKeysChanged(() => void refresh()).then((un) => {
        unlistenKeys = un;
      });
      const unsubPrefs = usePreferencesStore.subscribe((state, prev) => {
        if (state.autocompleteProvider !== prev.autocompleteProvider) {
          void refresh();
        }
      });
      return () => {
        cancelled = true;
        unlistenKeys?.();
        unsubPrefs();
      };
    }, []);
    const themeExt = getEditorThemeExtension(editorThemeId, customEditorThemes, path);

    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity — a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    const pathRef = useRef(path);
    pathRef.current = path;

    // Markdown files render as a full-pane preview by default; a toolbar
    // toggle drops to the raw source. CodeMirror stays mounted underneath the
    // preview overlay so git gutter, search and language all keep working and
    // the editor state survives toggling.
    const isMarkdown = /\.(md|markdown)$/i.test(path);
    const [showSource, setShowSource] = useState(false);
    // Reset to preview whenever the open file changes.
    useEffect(() => {
      setShowSource(false);
    }, [path]);
    // `doc.content` only changes on load/save, not per keystroke, so mirror the
    // live buffer here to render edits the moment the user flips to preview.
    const liveContentRef = useRef("");
    const [previewSource, setPreviewSource] = useState("");
    // Seed the preview from the document *during render* (React's "adjust state
    // while rendering" pattern) rather than in a post-paint effect, so the
    // first preview frame is never empty. `doc.content` only changes on
    // load/reload — exactly when the preview should reset — so the guard keeps
    // this from looping and never clobbers unsaved edits (autosave doesn't
    // touch `doc.content`).
    const seededContentRef = useRef<string | null>(null);
    if (doc.status === "ready" && seededContentRef.current !== doc.content) {
      seededContentRef.current = doc.content;
      liveContentRef.current = doc.content;
      setPreviewSource(doc.content);
    }
    const handleChange = useCallback(
      (next: string) => {
        liveContentRef.current = next;
        onChange(next);
      },
      [onChange],
    );
    const togglePreview = useCallback(() => {
      if (showSource) setPreviewSource(liveContentRef.current);
      setShowSource(!showSource);
    }, [showSource]);

    // Load the git baseline (index content) so the change gutter can mark
    // added/modified/deleted lines. Best-effort: outside a repo, untracked, or
    // any git error simply clears the gutter. Stable identity (reads pathRef),
    // and guards against a stale resolve landing after the file switched.
    const loadBaseline = useCallback(async () => {
      const view = cmRef.current?.view;
      if (!view) return;
      const target = pathRef.current;
      const repo = await resolveRepoCached(parentDir(target));
      if (pathRef.current !== target) return;
      if (!repo) {
        cmRef.current?.view?.dispatch({ effects: setGitBaseline.of(null) });
        return;
      }
      // Slice from the real (cased) string so git keeps the file's true casing,
      // but compare case-insensitively on Windows to find the prefix boundary.
      const root = repo.repoRoot.replace(/\\/g, "/").replace(/\/$/, "");
      const abs = target.replace(/\\/g, "/");
      const prefix = `${root}/`;
      const head = abs.slice(0, prefix.length);
      const inRepo = CASE_INSENSITIVE_FS
        ? head.toLowerCase() === prefix.toLowerCase()
        : head === prefix;
      const rel = inRepo ? abs.slice(prefix.length) : abs;
      try {
        const res = await native.gitDiffContent(repo.repoRoot, rel, false);
        if (pathRef.current !== target) return;
        cmRef.current?.view?.dispatch({
          effects: setGitBaseline.of(res.isBinary ? null : res.originalContent),
        });
      } catch {
        if (pathRef.current !== target) return;
        // Repo resolved but no index entry (untracked / new file): treat the
        // whole file as added so the gutter still reflects it.
        cmRef.current?.view?.dispatch({ effects: setGitBaseline.of("") });
      }
    }, []);
    const loadBaselineRef = useRef(loadBaseline);
    loadBaselineRef.current = loadBaseline;

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        vimHandlersExtension(() => ({
          save: () => {
            void (async () => {
              await saveRef.current();
              onSavedRef.current?.();
              void loadBaselineRef.current();
            })();
          },
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        gitGutter(),
        languageCompartment.of([]),
        inlineCompletion({
          getPrefs: () => {
            const s = usePreferencesStore.getState();
            const p = s.autocompleteProvider;
            const modelId =
              p === "lmstudio"
                ? s.lmstudioModelId
                : p === "mlx"
                  ? s.mlxModelId
                  : p === "ollama"
                    ? s.ollamaModelId
                    : p === "openai-compatible"
                      ? s.openaiCompatibleModelId
                      : p === "openrouter"
                        ? s.openrouterModelId
                        : s.autocompleteModelId;
            return {
              enabled: s.autocompleteEnabled,
              provider: p,
              modelId,
              apiKey: apiKeyRef.current,
              lmstudioBaseURL: s.lmstudioBaseURL,
              mlxBaseURL: s.mlxBaseURL,
              ollamaBaseURL: s.ollamaBaseURL,
              openaiCompatibleBaseURL: s.openaiCompatibleBaseURL,
            };
          },
          getPath: () => pathRef.current,
          getLanguage: () => languageRef.current,
        }),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void (async () => {
                await saveRef.current();
                onSavedRef.current?.();
                void loadBaselineRef.current();
              })();
              return true;
            },
          },
        ]),
      ],
      [],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(
          vimMode ? Prec.highest(vim()) : [],
        ),
      });
    }, [vimMode]);

    useEffect(() => {
      let cancelled = false;
      const ext = path.split(".").pop()?.toLowerCase() ?? null;
      languageRef.current = ext;
      const resolve = async (): Promise<Extension> => {
        if (path.toLowerCase().endsWith(".terax-theme")) {
          const [{ json }, { colorSwatches }] = await Promise.all([
            import("@codemirror/lang-json"),
            import("./lib/colorSwatches"),
          ]);
          return [json(), colorSwatches()];
        }
        return (await resolveLanguage(path)) ?? [];
      };
      void resolve().then((extension) => {
        if (cancelled) return;
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: languageCompartment.reconfigure(extension),
        });
      });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status]);

    // (Re)load the git baseline when the file opens or finishes loading.
    useEffect(() => {
      if (doc.status !== "ready") return;
      void loadBaseline();
    }, [path, doc.status, loadBaseline]);

    // Refresh the baseline when the open file changes on disk (e.g. a git
    // checkout or external edit rewrites it), so the gutter doesn't go stale.
    useEffect(() => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      void listenFsChanged((paths) => {
        if (paths.some((p) => samePath(p, pathRef.current))) {
          void loadBaselineRef.current();
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (q: string) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
          });
          if (q) findNext(view);
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view) findNext(view);
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view) findPrevious(view);
        },
        clearQuery: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
        },
        focus: () => {
          cmRef.current?.view?.focus();
        },
        gotoLine: (line: number) => {
          const view = cmRef.current?.view;
          if (view) revealLine(view, line);
          else pendingLineRef.current = line;
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        reload: () => reloadRef.current(),
        undo: () => {
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
      }),
      [path, revealLine],
    );

    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Loading…
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "binary") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">Binary file</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} · preview not supported
          </div>
        </div>
      );
    }
    if (doc.status === "toolarge") {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">File too large</div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} exceeds the {formatBytes(doc.limit)} limit.
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        {isMarkdown && (
          <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-3 py-1.5 text-[11px]">
            <span className="text-muted-foreground">
              {showSource ? "Editing source" : "Markdown preview"}
            </span>
            <button
              type="button"
              onClick={togglePreview}
              className="rounded px-2 py-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              {showSource ? "Show preview" : "Edit source"}
            </button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          <CodeMirror
            ref={cmRef}
            value={doc.content}
            onChange={handleChange}
            onCreateEditor={(view) => {
              const pending = pendingLineRef.current;
              if (pending != null) {
                pendingLineRef.current = null;
                // Defer one frame so the layout/scroll geometry is settled.
                requestAnimationFrame(() => revealLine(view, pending));
              }
            }}
            theme={themeExt}
            extensions={extensions}
            height="100%"
            className="h-full min-h-0 overflow-hidden"
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              foldGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
              searchKeymap: true,
            }}
          />
          {isMarkdown && !showSource && (
            <div className="absolute inset-0 overflow-auto bg-background px-6 py-4">
              <MarkdownContent content={previewSource} />
            </div>
          )}
        </div>
      </div>
    );
  },
);
