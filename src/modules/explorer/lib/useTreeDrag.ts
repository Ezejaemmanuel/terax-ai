import { useCallback, useEffect, useRef, useState } from "react";
import { isDescendantOrSelf, parentDir } from "./explorerDnd";

// Pixels the pointer must travel before a press becomes a drag (vs a click).
const DRAG_THRESHOLD_PX = 5;
// Hovering a folder for this long during a drag springs it open.
const AUTO_EXPAND_MS = 600;

export type TreeDragState = {
  /** True once the press has crossed the threshold into an actual drag. */
  active: boolean;
  /** Directory that would receive a drop right now, or null if none is valid. */
  targetDir: string | null;
  /** Item count, for the drag overlay. */
  count: number;
  /** Overlay caption (a single name, or "N items"). */
  label: string;
  /** Whether the held modifier means copy (vs move). */
  copy: boolean;
};

const IDLE: TreeDragState = {
  active: false,
  targetDir: null,
  count: 0,
  label: "",
  copy: false,
};

type Session = {
  sources: string[];
  startX: number;
  startY: number;
  started: boolean;
};

type Options = {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Floating element that follows the cursor; positioned imperatively. */
  overlayRef: React.RefObject<HTMLElement | null>;
  rootPath: string | null;
  onExpand: (path: string) => void;
  onDrop: (targetDir: string, sources: string[], copy: boolean) => void;
};

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Pointer-event–based drag for the file tree. A press that moves past a small
 * threshold becomes a drag; the directory under the cursor is resolved from the
 * DOM (`[data-fs-path]` / `data-fs-dir`), folders spring open on hover, and the
 * release performs a move (or copy with Ctrl/Cmd). Listeners are bound on the
 * window for the duration of the drag and torn down via an AbortController.
 */
export function useTreeDrag(opts: Options) {
  const [state, setState] = useState<TreeDragState>(IDLE);

  // Window listeners are bound once per drag; reading the latest options from a
  // ref keeps them current without rebinding.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const session = useRef<Session | null>(null);
  const autoExpand = useRef<{ path: string; timer: number } | null>(null);
  const ac = useRef<AbortController | null>(null);
  const justDragged = useRef(false);
  // Latest cursor position, so the overlay can be placed correctly on the very
  // first render (before any imperative move) — avoids a one-frame flash at 0,0.
  const pointer = useRef({ x: 0, y: 0 });

  const clearAutoExpand = useCallback(() => {
    if (autoExpand.current) {
      clearTimeout(autoExpand.current.timer);
      autoExpand.current = null;
    }
  }, []);

  const scheduleAutoExpand = useCallback(
    (dir: string | null) => {
      if (autoExpand.current?.path === dir) return;
      clearAutoExpand();
      if (!dir) return;
      const timer = window.setTimeout(() => {
        autoExpand.current = null;
        optsRef.current.onExpand(dir);
      }, AUTO_EXPAND_MS);
      autoExpand.current = { path: dir, timer };
    },
    [clearAutoExpand],
  );

  // The directory under the pointer, or null when the drop isn't allowed
  // (outside the panel, or into the dragged item itself / a descendant).
  const resolveTarget = useCallback(
    (e: PointerEvent): { dir: string | null; copy: boolean } => {
      const copy = e.ctrlKey || e.metaKey;
      const { containerRef, rootPath } = optsRef.current;
      const container = containerRef.current;
      const s = session.current;
      if (!container || !rootPath || !s) return { dir: null, copy };
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el || !container.contains(el)) return { dir: null, copy };
      const rowEl = el.closest<HTMLElement>("[data-fs-path]");
      let dir = rootPath;
      if (rowEl) {
        const p = rowEl.getAttribute("data-fs-path");
        if (p) dir = rowEl.getAttribute("data-fs-dir") === "1" ? p : parentDir(p, rootPath);
      }
      if (s.sources.some((src) => isDescendantOrSelf(dir, src))) return { dir: null, copy };
      return { dir, copy };
    },
    [],
  );

  const reset = useCallback(() => {
    ac.current?.abort();
    ac.current = null;
    clearAutoExpand();
    document.body.style.userSelect = "";
    session.current = null;
    setState(IDLE);
  }, [clearAutoExpand]);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const s = session.current;
      if (!s) return;
      pointer.current = { x: e.clientX, y: e.clientY };
      if (!s.started) {
        if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD_PX) return;
        s.started = true;
        document.body.style.userSelect = "none";
        setState({
          active: true,
          targetDir: null,
          count: s.sources.length,
          label: s.sources.length === 1 ? baseName(s.sources[0]) : `${s.sources.length} items`,
          copy: e.ctrlKey || e.metaKey,
        });
      }
      const overlay = optsRef.current.overlayRef.current;
      if (overlay) overlay.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
      const { dir, copy } = resolveTarget(e);
      scheduleAutoExpand(dir);
      setState((st) =>
        st.targetDir === dir && st.copy === copy ? st : { ...st, targetDir: dir, copy },
      );
    },
    [resolveTarget, scheduleAutoExpand],
  );

  const onUp = useCallback(
    (e: PointerEvent) => {
      const s = session.current;
      if (s?.started) {
        const { dir, copy } = resolveTarget(e);
        if (dir && !s.sources.some((src) => isDescendantOrSelf(dir, src))) {
          optsRef.current.onDrop(dir, s.sources, copy);
        }
        // Suppress the click that fires right after the release ends the drag.
        justDragged.current = true;
        window.setTimeout(() => {
          justDragged.current = false;
        }, 0);
      }
      reset();
    },
    [resolveTarget, reset],
  );

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") reset();
    },
    [reset],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent, sources: string[]) => {
      if (e.button !== 0 || sources.length === 0) return;
      session.current = { sources, startX: e.clientX, startY: e.clientY, started: false };
      const controller = new AbortController();
      ac.current = controller;
      const { signal } = controller;
      window.addEventListener("pointermove", onMove, { signal });
      window.addEventListener("pointerup", onUp, { signal });
      window.addEventListener("pointercancel", reset, { signal });
      window.addEventListener("keydown", onKey, { signal });
    },
    [onMove, onUp, onKey, reset],
  );

  /** True if a drag just ended, so the row can ignore the trailing click. */
  const didDrag = useCallback(() => justDragged.current, []);

  /** Live cursor position, for placing the overlay on its first paint. */
  const pointerRef = pointer;

  // Tear down listeners/timers if the tree unmounts mid-drag.
  useEffect(
    () => () => {
      ac.current?.abort();
      clearAutoExpand();
    },
    [clearAutoExpand],
  );

  return { state, onPointerDown, didDrag, pointerRef };
}
