// In-window request to open a file in a tab, optionally at a line. Used by
// features nested far below the tab layer (go-to-definition, the Problems
// list), which would otherwise need a prop threaded through every level.

type Request = { path: string; line?: number; column?: number };
type Listener = (request: Request) => void;

const listeners = new Set<Listener>();

export function requestOpenFile(request: Request): void {
  for (const listener of listeners) listener(request);
}

export function onOpenFileRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
