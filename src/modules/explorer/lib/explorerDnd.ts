/**
 * Pure helpers shared by the file-tree drag-and-drop logic.
 *
 * Internal drag is driven by pointer events (see `useTreeDrag`) rather than the
 * HTML5 Drag and Drop API: Tauri's native drag-drop handler (`dragDropEnabled`,
 * on by default and required for OS→window file drops) suppresses DOM drag
 * events, so HTML5 `draggable` never fires inside the webview.
 */

/**
 * True when `targetDir` is the source itself or sits inside it — dropping a
 * folder onto itself or into one of its own descendants is never valid.
 * Path separators are normalized so Windows backslashes compare correctly.
 */
export function isDescendantOrSelf(targetDir: string, source: string): boolean {
  const t = targetDir.replace(/\\/g, "/");
  const s = source.replace(/\\/g, "/");
  return t === s || t.startsWith(`${s}/`);
}

/** The parent directory of `path`, or `fallback` when `path` has no parent. */
export function parentDir(path: string, fallback: string): string {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : fallback;
}
