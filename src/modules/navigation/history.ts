// Back/forward history for file navigation, the thing Alt+Left and Alt+Right
// move through. Positions only: no tab ids, so an entry survives the tab being
// closed and reopened.

export type NavEntry = { path: string; line?: number };

// Bounded so a long session cannot grow this without limit; older entries are
// the ones nobody walks back to.
const LIMIT = 64;

const past: NavEntry[] = [];
const future: NavEntry[] = [];
let current: NavEntry | null = null;

function samePlace(a: NavEntry, b: NavEntry): boolean {
  return a.path === b.path && (a.line ?? null) === (b.line ?? null);
}

/**
 * Records a jump to `entry`. `from` is the line the user is leaving, so going
 * back returns to where they actually were rather than to wherever they
 * happened to enter that file.
 */
export function recordNavigation(entry: NavEntry, from?: number | null): void {
  if (current && from != null) current = { ...current, line: from };
  if (current && samePlace(current, entry)) return;
  if (current) {
    past.push(current);
    if (past.length > LIMIT) past.shift();
  }
  current = entry;
  future.length = 0;
}

/** The place to return to, or null when there is no history behind us. */
export function navigateBack(from?: number | null): NavEntry | null {
  const previous = past.pop();
  if (!previous) return null;
  if (current) future.unshift(from == null ? current : { ...current, line: from });
  current = previous;
  return previous;
}

export function navigateForward(from?: number | null): NavEntry | null {
  const next = future.shift();
  if (!next) return null;
  if (current) {
    past.push(from == null ? current : { ...current, line: from });
    if (past.length > LIMIT) past.shift();
  }
  current = next;
  return next;
}

export function canNavigateBack(): boolean {
  return past.length > 0;
}

export function canNavigateForward(): boolean {
  return future.length > 0;
}

/** Drops every entry for a path that no longer exists, e.g. a deleted file. */
export function forgetNavigation(path: string): void {
  for (const list of [past, future]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].path === path) list.splice(i, 1);
    }
  }
  if (current?.path === path) current = null;
}

export function resetNavigation(): void {
  past.length = 0;
  future.length = 0;
  current = null;
}
