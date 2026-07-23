/// Best-effort mirror of the backend's `rel_label` (see
/// `src-tauri/src/modules/ai_history.rs`): turns an absolute tool path into
/// something short enough to read on a phone. Falls back to the original
/// string whenever the relationship to `cwd` isn't obvious rather than
/// guessing wrong.
export function toRelativePath(raw: string, cwd: string | null | undefined): string {
  if (!raw || !cwd) return raw;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = norm(raw);
  const base = norm(cwd);
  if (!base) return raw;

  // Windows paths are case-insensitive; compare folded but keep the original
  // casing in the result.
  const pathLower = path.toLowerCase();
  const baseLower = base.toLowerCase();
  if (pathLower === baseLower) return ".";

  const prefix = `${baseLower}/`;
  if (pathLower.startsWith(prefix)) {
    return path.slice(prefix.length);
  }
  return raw;
}
