// Shared file-tree helpers used by both the Source Control panel and the AI
// session diff sidebar, so the two render changed files identically.

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

export function pathStartsWithFolder(path: string, folderPath: string): boolean {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

/** Tailwind text color for a single-letter git status code. */
export function statusBadgeClass(code: string): string {
  switch (code) {
    case "A":
      return "text-emerald-400";
    case "U":
      return "text-teal-400";
    case "M":
      return "text-amber-400";
    case "D":
      return "text-rose-400";
    case "R":
      return "text-sky-400";
    default:
      return "text-muted-foreground/60";
  }
}

export type FileTreeNode<T> =
  | { kind: "folder"; path: string; name: string; depth: number; childCount: number }
  | { kind: "file"; entry: T; depth: number };

/**
 * Group a flat list of entries (each with a `path`) into a depth-first list of
 * folder + file nodes, honoring a set of collapsed folder paths. Folders sort
 * before files, both alphabetically — matching the Source Control tree.
 */
export function flattenFileTree<T extends { path: string }>(
  entries: T[],
  collapsed: Set<string>,
): FileTreeNode<T>[] {
  type Dir = { files: T[]; subdirs: Map<string, Dir> };
  const root: Dir = { files: [], subdirs: new Map() };

  for (const entry of entries) {
    const parts = entry.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!cur.subdirs.has(seg)) cur.subdirs.set(seg, { files: [], subdirs: new Map() });
      cur = cur.subdirs.get(seg)!;
    }
    cur.files.push(entry);
  }

  function countAll(dir: Dir): number {
    let n = dir.files.length;
    for (const sub of dir.subdirs.values()) n += countAll(sub);
    return n;
  }

  const result: FileTreeNode<T>[] = [];

  function walk(dir: Dir, prefix: string, depth: number) {
    const sortedDirs = [...dir.subdirs.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, subdir] of sortedDirs) {
      const folderPath = prefix ? `${prefix}/${name}` : name;
      result.push({ kind: "folder", path: folderPath, name, depth, childCount: countAll(subdir) });
      if (!collapsed.has(folderPath)) walk(subdir, folderPath, depth + 1);
    }
    const sortedFiles = [...dir.files].sort((a, b) =>
      basename(a.path).localeCompare(basename(b.path)),
    );
    for (const entry of sortedFiles) result.push({ kind: "file", entry, depth });
  }

  walk(root, "", 0);
  return result;
}
