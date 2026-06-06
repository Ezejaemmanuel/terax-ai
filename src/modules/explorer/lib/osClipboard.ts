import { hasFiles, readFiles } from "tauri-plugin-clipboard-api";

/**
 * Reads file/folder paths from the OS clipboard — e.g. items copied in Windows
 * Explorer or macOS Finder, which live in a native clipboard format
 * (`CF_HDROP` / `NSFilenamesPboardType`) that the standard web clipboard can't
 * see. Returns `[]` when the clipboard holds no files or the read fails, so
 * callers can simply fall back to the in-app clipboard.
 */
export async function readOsClipboardFiles(): Promise<string[]> {
  try {
    if (!(await hasFiles())) return [];
    const files = await readFiles();
    if (!Array.isArray(files)) return [];
    return files.filter((f): f is string => typeof f === "string" && f.length > 0);
  } catch {
    return [];
  }
}
