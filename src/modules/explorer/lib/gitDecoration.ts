import type { GitChangedFile } from "@/modules/ai/lib/native";

/**
 * The single status we display for a file or folder in the tree. A file can
 * carry several porcelain codes at once (e.g. staged-added + worktree-modified);
 * we collapse those to the strongest one. Folders aggregate the strongest status
 * found among their descendants.
 */
export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed"
  | "conflict";

export type GitDecoration = {
  status: GitFileStatus;
  /** Single-letter badge shown on the right of the row. */
  badge: string;
  isDir: boolean;
};

/**
 * Strength ranking for aggregation. When a folder contains several differently
 * changed files, the highest rank wins. A file with both an index and a
 * worktree code likewise resolves to its strongest interpretation.
 */
const STATUS_RANK: Record<GitFileStatus, number> = {
  conflict: 6,
  deleted: 5,
  // A rename outranks a modify so a renamed-and-edited file still reads as a
  // rename (the more notable event) rather than collapsing to "modified".
  renamed: 4,
  modified: 3,
  added: 2,
  untracked: 1,
};

const BADGE: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "U",
  renamed: "R",
  conflict: "C",
};

const COLOR_CLASS: Record<GitFileStatus, string> = {
  modified: "text-git-modified",
  added: "text-git-added",
  deleted: "text-git-deleted",
  untracked: "text-git-untracked",
  renamed: "text-git-renamed",
  conflict: "text-git-conflict",
};

export function badgeFor(status: GitFileStatus): string {
  return BADGE[status];
}

export function colorClassFor(status: GitFileStatus): string {
  return COLOR_CLASS[status];
}

/** Map a single porcelain status character to our display status. */
function statusFromCode(code: string): GitFileStatus | null {
  switch (code) {
    case "M":
    case "T": // type change — treat as a modification
      return "modified";
    case "A":
    case "C": // copied — closest to a new file
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "U":
      return "conflict";
    case "?":
      return "untracked";
    default:
      return null;
  }
}

function stronger(a: GitFileStatus, b: GitFileStatus): GitFileStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * Collapse a changed file's index + worktree codes into one display status.
 * Untracked files are flagged explicitly by git; conflicts ("U") win outright.
 */
export function mapChangedFile(file: GitChangedFile): GitFileStatus {
  if (file.untracked) return "untracked";

  let result: GitFileStatus | null = null;
  for (const code of [file.indexStatus, file.worktreeStatus]) {
    if (!code || code === " ") continue;
    const mapped = statusFromCode(code);
    if (!mapped) continue;
    result = result ? stronger(result, mapped) : mapped;
  }
  // Anything genuinely changed but unrecognized still reads as "modified".
  return result ?? "modified";
}

/**
 * Normalize a filesystem path for map keys/lookups so the tree's paths (derived
 * from the workspace cwd) and git's paths (derived from the repo root) compare
 * equal. Forward-slashes everywhere, no trailing slash, and case-folded on
 * case-insensitive platforms (Windows) where `C:/` and `c:/` denote the same
 * file.
 */
export function normalizePath(path: string, caseInsensitive: boolean): string {
  let p = path.replace(/\\/g, "/");
  // Drop a trailing slash unless the whole path is "/".
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return caseInsensitive ? p.toLowerCase() : p;
}

/** Join a repo root with a repo-relative path into an absolute, slash path. */
export function joinRepoPath(repoRoot: string, relPath: string): string {
  const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${root}/${rel}`;
}

/**
 * Build a lookup from normalized absolute path → decoration, covering every
 * changed file and every ancestor folder up to (but excluding) the repo root.
 * Folders carry the strongest status among their descendants, matching how
 * VSCode tints a folder that contains changes.
 */
export function buildDecorationMap(
  repoRoot: string,
  changedFiles: GitChangedFile[],
  caseInsensitive: boolean,
): Map<string, GitDecoration> {
  const map = new Map<string, GitDecoration>();
  const rootKey = normalizePath(repoRoot, caseInsensitive);

  const bumpFolder = (key: string, status: GitFileStatus) => {
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { status, badge: badgeFor(status), isDir: true });
      return;
    }
    const next = stronger(existing.status, status);
    if (next !== existing.status) {
      map.set(key, { status: next, badge: badgeFor(next), isDir: true });
    }
  };

  for (const file of changedFiles) {
    const status = mapChangedFile(file);
    const absPath = joinRepoPath(repoRoot, file.path);
    const fileKey = normalizePath(absPath, caseInsensitive);
    // A blank or "." path would collapse onto the repo root; never tag the root
    // itself as a changed file.
    if (!fileKey || fileKey === rootKey) continue;
    map.set(fileKey, { status, badge: badgeFor(status), isDir: false });

    // Walk up the ancestor folders, tinting each, stopping at the repo root.
    let parent = parentKey(fileKey);
    while (parent && parent !== rootKey && parent.length > rootKey.length) {
      bumpFolder(parent, status);
      const next = parentKey(parent);
      if (next === parent) break;
      parent = next;
    }
  }

  return map;
}

function parentKey(key: string): string {
  const i = key.lastIndexOf("/");
  if (i <= 0) return "";
  return key.slice(0, i);
}
