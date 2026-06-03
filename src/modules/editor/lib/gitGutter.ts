// A VS Code-style "dirty gutter" for the live editor: a thin colored bar in a
// dedicated gutter marking lines added / modified / deleted relative to the
// file's git baseline (the index — `git show :path`). The baseline is supplied
// from outside via the `setGitBaseline` effect; the diff is recomputed
// (debounced) as the buffer changes.

import { presentableDiff } from "@codemirror/merge";
import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  ViewPlugin,
  gutter,
  type ViewUpdate,
} from "@codemirror/view";

/** Set (or clear, with null) the git baseline the gutter diffs against. */
export const setGitBaseline = StateEffect.define<string | null>();

const setGitMarks = StateEffect.define<RangeSet<GutterMarker>>();

const baselineField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGitBaseline)) return e.value;
    return value;
  },
});

const marksField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGitMarks)) return e.value;
    // Keep marker positions valid through edits until the next recompute.
    return value.map(tr.changes);
  },
});

type ChangeKind = "added" | "modified" | "deleted";

class ChangeMarker extends GutterMarker {
  constructor(readonly kind: ChangeKind) {
    super();
  }
  override toDOM() {
    const el = document.createElement("div");
    el.className = `cm-gitChange cm-gitChange-${this.kind}`;
    return el;
  }
}

// Above this size the per-keystroke full-document diff stutters; skip the
// gutter entirely (matches the session diff editor's content cap).
const GUTTER_SIZE_CAP = 512 * 1024;

const MARKERS: Record<ChangeKind, ChangeMarker> = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
};

function computeMarks(state: EditorState): RangeSet<GutterMarker> {
  const baseline = state.field(baselineField);
  if (baseline == null) return RangeSet.empty;
  const current = state.doc.toString();
  if (current.length > GUTTER_SIZE_CAP || baseline.length > GUTTER_SIZE_CAP) {
    return RangeSet.empty;
  }

  // Match the baseline's line endings to the document's. With core.autocrlf the
  // index blob is LF while the working copy is CRLF — diffing them raw would
  // flag every line as changed. Normalizing keeps `fromB` offsets valid for
  // `state.doc` because both strings then share the document's EOL.
  const docIsCRLF = current.includes("\r\n");
  const normBaseline = baseline.replace(/\r\n/g, "\n");
  const base = docIsCRLF ? normBaseline.replace(/\n/g, "\r\n") : normBaseline;
  if (base === current) return RangeSet.empty;

  const changes = presentableDiff(base, current);
  // Collect per-line kind first so the RangeSet is built strictly in order
  // (modified wins over added wins over deleted on the same line).
  const lineKind = new Map<number, ChangeKind>();
  const note = (line: number, kind: ChangeKind) => {
    const prev = lineKind.get(line);
    if (prev === "modified") return;
    if (prev === "added" && kind === "deleted") return;
    lineKind.set(line, kind);
  };

  const docLen = state.doc.length;
  for (const c of changes) {
    const insertedAny = c.toB > c.fromB;
    const deletedAny = c.toA > c.fromA;
    if (insertedAny) {
      const kind: ChangeKind = deletedAny ? "modified" : "added";
      const startLine = state.doc.lineAt(Math.min(c.fromB, docLen)).number;
      const endLine = state.doc.lineAt(
        Math.min(Math.max(c.fromB, c.toB - 1), docLen),
      ).number;
      for (let ln = startLine; ln <= endLine; ln++) note(ln, kind);
    } else if (deletedAny) {
      // Pure deletion: nothing remains in the buffer — mark the adjacent line.
      const ln = state.doc.lineAt(Math.min(c.fromB, docLen)).number;
      note(ln, "deleted");
    }
  }

  const sorted = [...lineKind.keys()].sort((a, b) => a - b);
  const ranges = sorted.map((ln) => {
    const line = state.doc.line(ln);
    return MARKERS[lineKind.get(ln)!].range(line.from);
  });
  return RangeSet.of(ranges, true);
}

const recomputePlugin = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;
    constructor(view: EditorView) {
      this.schedule(view);
    }
    update(u: ViewUpdate) {
      const baselineChanged = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setGitBaseline)),
      );
      if (u.docChanged || baselineChanged) this.schedule(u.view);
    }
    schedule(view: EditorView) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        const marks = computeMarks(view.state);
        view.dispatch({ effects: setGitMarks.of(marks) });
      }, 250);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

const gutterTheme = EditorView.baseTheme({
  // No fixed width and no spacer, so the gutter collapses to 0 for files with
  // no baseline or no changes, and only takes space when markers are present.
  ".cm-gitChangeGutter": {
    paddingLeft: "0",
    paddingRight: "0",
  },
  ".cm-gitChangeGutter .cm-gutterElement": {
    padding: "0",
    display: "flex",
    alignItems: "center",
  },
  // Added / modified: a full-height colored bar.
  ".cm-gitChange-added, .cm-gitChange-modified": {
    width: "3px",
    alignSelf: "stretch",
  },
  ".cm-gitChange-added": {
    backgroundColor: "var(--git-added, #3fb950)",
  },
  ".cm-gitChange-modified": {
    backgroundColor: "var(--git-modified, #d29922)",
  },
  // Deletion has no line of its own — show a centered right-pointing wedge.
  // Kept at the same 3px box width as the bars so the gutter column doesn't
  // jitter when scrolling between changed and deleted regions.
  ".cm-gitChange-deleted": {
    width: "0",
    height: "0",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "3px solid var(--git-deleted, #f85149)",
  },
});

const changeGutter = gutter({
  class: "cm-gitChangeGutter",
  markers: (view) => view.state.field(marksField),
});

/** The full git-gutter extension. Add once to the editor's extension list. */
export function gitGutter(): Extension {
  return [baselineField, marksField, recomputePlugin, changeGutter, gutterTheme];
}
