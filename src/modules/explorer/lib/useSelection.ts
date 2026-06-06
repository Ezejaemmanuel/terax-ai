import { useCallback, useRef, useState } from "react";

/** Modifier intent for a click/selection gesture. */
export type SelectMods = {
  /** Ctrl/Cmd — toggle this path in the existing selection. */
  additive?: boolean;
  /** Shift — select the contiguous range from the anchor to this path. */
  range?: boolean;
};

type SelectionState = {
  selected: Set<string>;
  /** The active path for keyboard navigation (the most recently touched row). */
  lead: string | null;
};

const EMPTY: SelectionState = { selected: new Set(), lead: null };

/**
 * The contiguous slice of `order` between `a` and `b` (inclusive), regardless of
 * which comes first. If either endpoint is no longer in `order` (e.g. its folder
 * was collapsed) the range degenerates to just `b`. Pure and exported for tests.
 */
export function pathRange(order: string[], a: string, b: string): string[] {
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia === -1 || ib === -1) return [b];
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia];
  return order.slice(lo, hi + 1);
}

/**
 * Multi-select model for the file tree. Range selection is computed against the
 * current flattened, visible row order (`orderedPaths`), which the caller passes
 * fresh each render — so expanding/collapsing folders naturally re-scopes ranges.
 */
export function useSelection(orderedPaths: string[]) {
  const [state, setState] = useState<SelectionState>(EMPTY);
  // Anchor is the fixed end of a shift-range; it survives re-renders and isn't
  // part of React state because changing it never needs to repaint on its own.
  const anchorRef = useRef<string | null>(null);
  const orderRef = useRef(orderedPaths);
  orderRef.current = orderedPaths;

  const rangeBetween = (a: string, b: string): string[] =>
    pathRange(orderRef.current, a, b);

  const select = useCallback((path: string, mods?: SelectMods) => {
    setState((prev) => {
      if (mods?.range && anchorRef.current) {
        const range = rangeBetween(anchorRef.current, path);
        // Ctrl+Shift extends the existing selection; plain Shift replaces it.
        const next = mods.additive ? new Set(prev.selected) : new Set<string>();
        for (const p of range) next.add(p);
        return { selected: next, lead: path };
      }
      if (mods?.additive) {
        const next = new Set(prev.selected);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        anchorRef.current = path;
        return { selected: next, lead: path };
      }
      anchorRef.current = path;
      return { selected: new Set([path]), lead: path };
    });
  }, []);

  /** Keyboard move: shift the lead by `delta` rows, optionally extending the range. */
  const moveLead = useCallback((delta: number, extend: boolean) => {
    setState((prev) => {
      const order = orderRef.current;
      if (order.length === 0) return prev;
      const curIdx = prev.lead ? order.indexOf(prev.lead) : -1;
      const nextIdx =
        curIdx < 0
          ? delta > 0
            ? 0
            : order.length - 1
          : Math.max(0, Math.min(order.length - 1, curIdx + delta));
      const nextPath = order[nextIdx];
      if (extend && anchorRef.current) {
        return { selected: new Set(rangeBetween(anchorRef.current, nextPath)), lead: nextPath };
      }
      anchorRef.current = nextPath;
      return { selected: new Set([nextPath]), lead: nextPath };
    });
  }, []);

  /** Collapse the selection to a single path (e.g. focus-first, ArrowLeft-to-parent). */
  const setLead = useCallback((path: string) => {
    anchorRef.current = path;
    setState({ selected: new Set([path]), lead: path });
  }, []);

  /** Drop any selected/lead paths that are no longer present in the tree. */
  const prune = useCallback((isValid: (path: string) => boolean) => {
    setState((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const p of prev.selected) {
        if (isValid(p)) next.add(p);
        else changed = true;
      }
      const lead = prev.lead && isValid(prev.lead) ? prev.lead : null;
      if (!changed && lead === prev.lead) return prev;
      if (lead === null) anchorRef.current = null;
      return { selected: next, lead };
    });
  }, []);

  return {
    selected: state.selected,
    lead: state.lead,
    select,
    moveLead,
    setLead,
    prune,
  };
}
