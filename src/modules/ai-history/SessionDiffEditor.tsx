import { ScrollArea } from "@/components/ui/scroll-area";
import {
  buildSharedExtensions,
  languageCompartment,
} from "@/modules/editor/lib/extensions";
import {
  resolveLanguage,
  resolveLanguageSync,
} from "@/modules/editor/lib/languageResolver";
import { getEditorThemeExtension } from "@/modules/editor/lib/themes";
import { useCustomEditorThemesStore } from "@/modules/editor/useCustomEditorThemesStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";

// Same syntax/font setup the Source Control diff (GitDiffPane) uses, so a
// session diff reads at the normal editor size with full highlighting.
const SHARED_EXT: Extension[] = buildSharedExtensions();
const READONLY_EXT: Extension[] = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];

const DIFF_THEME = EditorView.theme({
  "&.cm-merge-b .cm-changedText, .cm-changedText": {
    background: "rgba(110, 200, 120, 0.20) !important",
    borderRadius: "3px",
    padding: "0 1px",
  },
  ".cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": {
    background: "rgba(220, 90, 90, 0.22) !important",
    borderRadius: "3px",
    padding: "0 1px",
  },
  "&.cm-merge-b .cm-changedLine, .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "rgba(110, 200, 120, 0.05) !important",
  },
  ".cm-deletedChunk": {
    backgroundColor: "rgba(220, 90, 90, 0.05) !important",
    paddingTop: "1px",
    paddingBottom: "1px",
  },
  "&.cm-merge-b .cm-changedLineGutter, .cm-changedLineGutter": {
    background: "rgba(110, 200, 120, 0.55) !important",
  },
  ".cm-deletedLineGutter, &.cm-merge-a .cm-changedLineGutter": {
    background: "rgba(220, 90, 90, 0.5) !important",
  },
  ".cm-changeGutter": {
    width: "2px !important",
    paddingLeft: "0 !important",
  },
  ".cm-collapsedLines": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground, #9ca3af)",
    fontSize: "10.5px",
    padding: "2px 8px",
    opacity: 0.7,
  },
});

type Props = {
  path: string;
  originalContent: string;
  modifiedContent: string;
  /** True when the backend couldn't ship raw content (binary / too large). */
  isBinary: boolean;
  /** Unified-diff patch text used as a fallback render. */
  fallbackPatch: string;
};

export function SessionDiffEditor({
  path,
  originalContent,
  modifiedContent,
  isBinary,
  fallbackPatch,
}: Props) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const editorThemeId = usePreferencesStore((s) => s.editorTheme);
  const customEditorThemes = useCustomEditorThemesStore((s) => s.customEditorThemes);
  const themeExt = getEditorThemeExtension(editorThemeId, customEditorThemes, path);

  const initialLang = useMemo(() => resolveLanguageSync(path), [path]);

  const extensions = useMemo(() => {
    const lineCount = Math.max(
      originalContent.split("\n").length,
      modifiedContent.split("\n").length,
    );
    // Show the whole file (all unchanged context) unless it's large; only then
    // collapse unchanged regions to keep the diff responsive.
    const shouldCollapse = lineCount >= 3000;
    return [
      ...SHARED_EXT,
      languageCompartment.of(initialLang ?? []),
      ...READONLY_EXT,
      unifiedMergeView({
        original: originalContent,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: shouldCollapse ? { margin: 3, minSize: 6 } : undefined,
      }),
      DIFF_THEME,
    ];
  }, [originalContent, modifiedContent, initialLang]);

  // Resolve syntax highlighting asynchronously when the language pack isn't
  // cached yet (mirrors GitDiffPane).
  useEffect(() => {
    if (isBinary || initialLang) return;
    let cancelled = false;
    resolveLanguage(path).then((ext) => {
      if (cancelled) return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({ effects: languageCompartment.reconfigure(ext ?? []) });
    });
    return () => {
      cancelled = true;
    };
  }, [isBinary, path, initialLang]);

  if (isBinary) {
    return (
      <ScrollArea className="h-full">
        <pre className="min-h-full whitespace-pre-wrap wrap-break-word p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
          {fallbackPatch || "Diff preview is not available for this file."}
        </pre>
      </ScrollArea>
    );
  }

  return (
    <CodeMirror
      ref={cmRef}
      value={modifiedContent}
      theme={themeExt}
      extensions={extensions}
      editable={false}
      height="100%"
      className="h-full"
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        searchKeymap: true,
      }}
    />
  );
}
