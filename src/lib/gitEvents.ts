// In-window notification that a git operation moved HEAD (commit, pull).
// Open editors diff their change gutter against HEAD, and a commit rewrites no
// file on disk, so the fs watcher cannot cover this case.

type Listener = (repoRoot: string) => void;

const listeners = new Set<Listener>();

export function notifyGitHeadChanged(repoRoot: string): void {
  for (const listener of listeners) listener(repoRoot);
}

export function onGitHeadChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
