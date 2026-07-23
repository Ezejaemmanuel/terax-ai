export type DiffLineType = "ctx" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffGap {
  type: "gap";
  count: number;
}

/// Cap on the O(n*m) LCS table. Tool edits are almost always small hunks; a
/// pasted 10k-line file shouldn't be allowed to hang the render, so above
/// this we skip alignment and just show a straight remove-all/add-all pair.
const MAX_DIFF_CELLS = 400_000;

/// Line-based diff (classic LCS alignment) between two full file contents.
/// Trims the shared prefix/suffix first so the DP table only ever covers the
/// part that actually changed — for a one-line edit in a large file that's a
/// handful of lines, not the whole file.
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const mid: DiffLine[] =
    midA.length * midB.length > MAX_DIFF_CELLS
      ? [
          ...midA.map((text): DiffLine => ({ type: "del", text })),
          ...midB.map((text): DiffLine => ({ type: "add", text })),
        ]
      : lcsDiff(midA, midB);

  return [
    ...a.slice(0, start).map((text): DiffLine => ({ type: "ctx", text })),
    ...mid,
    ...a.slice(endA).map((text): DiffLine => ({ type: "ctx", text })),
  ];
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const nextRow = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? nextRow[j + 1] + 1 : Math.max(nextRow[j], row[j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

/// Collapses long unchanged runs down to a few lines of context, mirroring
/// unified-diff hunks so a one-line edit in a large file doesn't render
/// thousands of untouched lines into the DOM.
export function collapseContext(lines: DiffLine[], context = 3): (DiffLine | DiffGap)[] {
  const out: (DiffLine | DiffGap)[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "ctx") {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].type === "ctx") j++;
    const runLength = j - i;
    if (runLength <= context * 2) {
      for (let k = i; k < j; k++) out.push(lines[k]);
    } else {
      const before = i === 0 ? 0 : context;
      const after = j === lines.length ? 0 : context;
      for (let k = i; k < i + before; k++) out.push(lines[k]);
      const hidden = runLength - before - after;
      if (hidden > 0) out.push({ type: "gap", count: hidden });
      for (let k = j - after; k < j; k++) out.push(lines[k]);
    }
    i = j;
  }
  return out;
}
