import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildTerminalTheme } from "@/styles/terminalTheme";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import {
  terminalDeleteSequence,
  terminalLineNavigationSequence,
  terminalWordNavigationSequence,
} from "./keymap";

export const POOL_MAX_SIZE = 5;
const FIT_DEBOUNCE_MS = 8;
const PTY_RESIZE_DEBOUNCE_MS = 256;
const SNAPSHOT_SCROLLBACK_CAP = 5_000;

export type SlotAdapter = {
  resolveLeaf(leafId: number): LeafBridge | null;
  evictLeaf(leafId: number): void;
  isLeafFocused(leafId: number): boolean;
};

export type LeafBridge = {
  writeToPty(data: string): void;
  // Paste clipboard text to the PTY, wrapping in bracketed-paste markers
  // (ESC[200~ / ESC[201~) iff the *application* currently has DECSET 2004 on.
  // That state is tracked on the session from PTY output, so it is correct
  // even after the renderer slot was reset()/stolen on a terminal switch —
  // unlike slot.term's own (resettable) bracketed-paste mode.
  pasteText(text: string): void;
  resizePty(cols: number, rows: number): void;
  // Force a SIGWINCH on the underlying PTY at the given dims. Implemented
  // as a +1 row / restore bump because the Linux kernel suppresses winsize
  // ioctls that don't actually change the size. Used to make alt-screen
  // TUIs repaint from scratch after they were dormant.
  kickPty(cols: number, rows: number): void;
};

export type Slot = {
  readonly id: number;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  readonly serializeAddon: SerializeAddon;
  readonly host: HTMLDivElement;
  webglAddon: WebglAddon | null;
  webglCanvases: HTMLCanvasElement[];
  currentLeafId: number | null;
  oscDisposers: (() => void)[];
  observer: ResizeObserver | null;
  fitTimer: ReturnType<typeof setTimeout> | null;
  ptyTimer: ReturnType<typeof setTimeout> | null;
  unhideRaf: number | null;
  lastCols: number;
  lastRows: number;
  lastW: number;
  lastH: number;
  lastUsedAt: number;
};

const slots: Slot[] = [];
let recyclerEl: HTMLDivElement | null = null;
let adapter: SlotAdapter | null = null;

export function configureRendererPool(a: SlotAdapter): void {
  adapter = a;
}

export function forEachSlot(fn: (slot: Slot) => void): void {
  for (const s of slots) fn(s);
}

export function poolSize(): number {
  return slots.length;
}

function getRecycler(): HTMLDivElement {
  if (recyclerEl && recyclerEl.isConnected) return recyclerEl;
  const el = document.createElement("div");
  el.setAttribute("data-terax-recycler", "");
  el.style.cssText =
    "position:fixed;left:-99999px;top:-99999px;width:1024px;height:768px;overflow:hidden;pointer-events:none;contain:strict;";
  document.body.appendChild(el);
  recyclerEl = el;
  return el;
}

const MCR_BG_ACTIVE = 4.5;
const MCR_BG_INACTIVE = 1;

function bgActive(
  prefs: ReturnType<typeof usePreferencesStore.getState>,
): boolean {
  return prefs.backgroundKind === "image" && !!prefs.backgroundImageId;
}

function termOptions() {
  const prefs = usePreferencesStore.getState();
  return {
    fontFamily: prefs.terminalFontFamily || detectMonoFontFamily(),
    letterSpacing: prefs.terminalLetterSpacing,
    fontSize: Math.max(4, Math.round(prefs.terminalFontSize * prefs.zoomLevel)),
    theme: buildTerminalTheme(),
    cursorBlink: false,
    cursorStyle: "bar" as const,
    cursorInactiveStyle: "outline" as const,
    scrollback: prefs.terminalScrollback,
    allowProposedApi: true,
    minimumContrastRatio: bgActive(prefs) ? MCR_BG_ACTIVE : MCR_BG_INACTIVE,
  };
}

export function applyBackgroundActive(active: boolean): void {
  const value = active ? MCR_BG_ACTIVE : MCR_BG_INACTIVE;
  for (const slot of slots) {
    if (slot.term.options.minimumContrastRatio === value) continue;
    slot.term.options.minimumContrastRatio = value;
  }
}

function createSlot(): Slot {
  const term = new Terminal(termOptions());
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const serializeAddon = new SerializeAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(serializeAddon);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => openUrl(uri).catch(console.error)),
  );

  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;";
  host.setAttribute("data-terax-slot", String(slots.length));
  getRecycler().appendChild(host);
  term.open(host);

  const slot: Slot = {
    id: slots.length,
    term,
    fitAddon,
    searchAddon,
    serializeAddon,
    host,
    webglAddon: null,
    webglCanvases: [],
    currentLeafId: null,
    oscDisposers: [],
    observer: null,
    fitTimer: null,
    ptyTimer: null,
    unhideRaf: null,
    lastCols: term.cols,
    lastRows: term.rows,
    lastW: 0,
    lastH: 0,
    lastUsedAt: 0,
  };

  attachWebgl(slot);

  // Copy-on-select: as soon as a selection finalizes, push it to the clipboard
  // so highlighting alone copies (no Ctrl+Shift+C, no right-click needed). Fires
  // as the selection grows; the final value is the full selection. Cleared
  // selections (no text) are ignored so we never wipe the clipboard.
  term.onSelectionChange(() => {
    if (!term.hasSelection()) return;
    const sel = term.getSelection();
    if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
  });

  // Intercept every paste (right-click menu, Ctrl+V, Shift+Insert) at the capture
  // phase, before xterm's own textarea paste handler runs, and route it through
  // the session. xterm's native paste bracketed only on its own reset-prone
  // bracketedPasteMode, so right-click pastes into a Claude Code whose mode had
  // been wiped arrived unwrapped and got truncated (newlines read as Enter, no
  // [Pasted +N lines]). The session path brackets on the app-tracked state and
  // writes the payload contiguously. stopPropagation in capture keeps the event
  // from reaching the textarea, so xterm never double-pastes.
  host.addEventListener(
    "paste",
    (event: ClipboardEvent) => {
      const leafId = slot.currentLeafId;
      if (leafId === null) return;
      const bridge = adapter?.resolveLeaf(leafId);
      if (!bridge) return;
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) bridge.pasteText(text);
    },
    true,
  );

  // WebView2's own right-click > Paste does not raise a ClipboardEvent on the
  // textarea; it arrives as beforeinput/insertFromPaste and is then applied as
  // ordinary text input. That misses the handler above *and* xterm's paste()
  // path, so the clipboard reached the pty unbracketed and dribbled in as many
  // small input events (measured: 6KB as 106 chunks over 7.6s) — every embedded
  // newline read as Enter, which is the truncated-paste bug. Catch that input
  // type too and route it through the same single contiguous bracketed write.
  host.addEventListener(
    "beforeinput",
    (event: InputEvent) => {
      if (
        event.inputType !== "insertFromPaste" &&
        event.inputType !== "insertFromPasteAsQuotation"
      ) {
        return;
      }
      const leafId = slot.currentLeafId;
      if (leafId === null) return;
      const bridge = adapter?.resolveLeaf(leafId);
      if (!bridge) return;
      event.preventDefault();
      event.stopPropagation();
      // dataTransfer is populated for paste-type beforeinput in Chromium; fall
      // back to the async clipboard read when it is empty.
      const direct =
        event.dataTransfer?.getData("text/plain") || event.data || "";
      if (direct) {
        bridge.pasteText(direct);
        return;
      }
      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) bridge.pasteText(text);
        })
        .catch(() => {});
    },
    true,
  );

  term.attachCustomKeyEventHandler((event) => {
    // During IME composition the browser is assembling a multi-keystroke
    // character (Chinese pinyin → hanzi, Korean jamo → syllable, etc.).
    // Raw keydown events — including the Enter that commits a candidate —
    // must NOT be forwarded to the PTY; xterm will receive the final
    // composed string through its own compositionend handler instead.
    // keyCode 229 ("Process") is what Chromium reports for every key
    // pressed inside an active IME session when isComposing is not yet set.
    if (event.isComposing || event.keyCode === 229) return false;

    const leafId = slot.currentLeafId;
    if (leafId === null) return false;
    const bridge = adapter?.resolveLeaf(leafId);
    if (!bridge) return true;
    const lineNavigation = terminalLineNavigationSequence(event, {
      isMac: IS_MAC,
    });
    if (lineNavigation) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(lineNavigation);
      return false;
    }
    const wordNavigation = terminalWordNavigationSequence(event);
    if (wordNavigation) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(wordNavigation);
      return false;
    }
    const deleteSeq = terminalDeleteSequence(event, { isMac: IS_MAC });
    if (deleteSeq) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty(deleteSeq);
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      if (event.type === "keydown") bridge.writeToPty("\x1b\r");
      return false;
    }
    if (isTerminalCopy(event)) {
      if (event.type === "keydown" && slot.term.hasSelection()) {
        const sel = slot.term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel).catch(() => {});
      }
      event.preventDefault();
      return false;
    }
    if (isTerminalPaste(event)) {
      if (event.type === "keydown") {
        void navigator.clipboard
          .readText()
          .then((text) => {
            // Route through the session (not slot.term.paste): the session
            // tracks the *application's* bracketed-paste state, which survives
            // the slot reset()/steal on terminal switch. slot.term's own mode
            // is wiped by reset() and frequently never re-synced, which made
            // multi-line pastes into a switched-to Claude Code collapse to a
            // single line. See LeafBridge.pasteText.
            if (text) bridge.pasteText(text);
          })
          .catch(() => {});
      }
      event.preventDefault();
      return false;
    }
    return true;
  });

  term.onData((data) => {
    const leafId = slot.currentLeafId;
    if (leafId === null) return;
    adapter?.resolveLeaf(leafId)?.writeToPty(data);
  });

  slots.push(slot);
  return slot;
}

type PickResult = { slot: Slot; previousLeafId: number | null };

function isAltScreen(s: Slot): boolean {
  try {
    return s.term.buffer.active.type === "alternate";
  } catch {
    return false;
  }
}

function pickSlotFor(leafId: number): PickResult {
  const free = slots.find((s) => s.currentLeafId === null);
  if (free) return { slot: free, previousLeafId: null };
  if (slots.length < POOL_MAX_SIZE)
    return { slot: createSlot(), previousLeafId: null };

  let best: Slot | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of slots) {
    if (s.currentLeafId === leafId) return { slot: s, previousLeafId: null };
    const focused =
      s.currentLeafId !== null &&
      (adapter?.isLeafFocused(s.currentLeafId) ?? false);
    const score =
      (isAltScreen(s) ? 100 : 0) + (focused ? 10 : 0) + s.lastUsedAt / 1e12;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  const chosen = best!;
  return { slot: chosen, previousLeafId: chosen.currentLeafId };
}

export type AcquireParams = {
  leafId: number;
  container: HTMLDivElement;
  snapshot: string | null;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the time it was released. When set, bindSlot skips ring replay
  // and kicks SIGWINCH so the TUI repaints from scratch.
  altScreen: boolean;
  // Input modes captured at the previous release, replayed after reset() so a
  // reattached main-screen app keeps bracketed paste / app-cursor-keys. Null on
  // the first bind (no prior release).
  modes: PreservedModes | null;
  drainRing: (write: (bytes: Uint8Array) => void) => void;
  shellExited: boolean;
  searchQuery: string | null;
  cols: number;
  rows: number;
  registerOsc: (term: Terminal) => (() => void)[];
  onSearchReady: (addon: SearchAddon) => void;
};

export function acquireSlot(params: AcquireParams): Slot {
  const existing = slots.find((s) => s.currentLeafId === params.leafId);
  if (existing) {
    rewireSlot(existing, params);
    return existing;
  }

  const pick = pickSlotFor(params.leafId);
  if (pick.previousLeafId !== null) {
    adapter?.evictLeaf(pick.previousLeafId);
  }
  if (
    pick.slot.currentLeafId !== null &&
    pick.slot.currentLeafId !== params.leafId
  ) {
    detachSlotFromLeaf(pick.slot);
  }
  bindSlot(pick.slot, params);
  return pick.slot;
}

function bindSlot(slot: Slot, p: AcquireParams): void {
  const stale =
    !slot.webglAddon || performance.now() - slot.lastUsedAt > SLOT_STALE_MS;
  slot.currentLeafId = p.leafId;
  slot.lastUsedAt = performance.now();

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "hidden";

  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }

  slot.term.options.disableStdin = p.shellExited;
  slot.term.clear();
  slot.term.reset();

  if (
    p.cols > 0 &&
    p.rows > 0 &&
    (slot.term.cols !== p.cols || slot.term.rows !== p.rows)
  ) {
    slot.term.resize(p.cols, p.rows);
  }

  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = p.registerOsc(slot.term);

  if (p.snapshot) {
    try {
      slot.term.write(p.snapshot);
    } catch (e) {
      console.warn("[terax] snapshot replay failed:", e);
    }
  }
  // Re-assert the modes that were live at release as the baseline (reset() wiped
  // them). Written before the ring drain so any mode toggle that happened while
  // detached replays on top as a delta — but if the original enabling sequence
  // has scrolled out of the capped ring, this baseline keeps e.g. bracketed
  // paste alive so pasting into a switched-to Claude Code still works.
  const modeRestore = modeRestoreSequence(p.modes);
  if (modeRestore) {
    try {
      slot.term.write(modeRestore);
    } catch {}
  }
  if (p.altScreen) {
    // Discard the dormant ring. TUI output is incremental cursor-positioned
    // updates that can't be replayed coherently on top of a stale snapshot
    // — see the SIGWINCH kick below, which makes the TUI redraw from scratch.
    p.drainRing(() => {});
  } else {
    p.drainRing((bytes) => slot.term.write(bytes));
  }
  try {
    slot.term.write("\x1b[?25h");
  } catch {}

  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.lastCols !== p.cols || slot.lastRows !== p.rows) {
    // resizePty updates session.cols/rows + pty backend; no separate scope call.
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.lastCols, slot.lastRows);
  }

  if (p.searchQuery) {
    try {
      slot.searchAddon.findNext(p.searchQuery);
    } catch {}
  }

  applyCursorBlinkOnSlot(slot, adapter?.isLeafFocused(p.leafId) ?? false);

  if (p.altScreen && !p.shellExited) {
    adapter?.resolveLeaf(p.leafId)?.kickPty(slot.term.cols, slot.term.rows);
  }

  scheduleUnhide(slot, stale);

  p.onSearchReady(slot.searchAddon);
}

function scheduleUnhide(slot: Slot, stale: boolean): void {
  slot.unhideRaf = requestAnimationFrame(() => {
    slot.unhideRaf = requestAnimationFrame(() => {
      slot.unhideRaf = null;
      slot.host.style.visibility = "";
      if (stale) {
        if (!slot.webglAddon) attachWebgl(slot);
        try {
          slot.term.refresh(0, slot.term.rows - 1);
        } catch {}
      }
      const leafId = slot.currentLeafId;
      if (leafId !== null && adapter?.isLeafFocused(leafId)) {
        slot.term.focus();
      }
    });
  });
}

function cancelPendingUnhide(slot: Slot): void {
  if (slot.unhideRaf !== null) {
    cancelAnimationFrame(slot.unhideRaf);
    slot.unhideRaf = null;
  }
}

function rewireSlot(slot: Slot, p: AcquireParams): void {
  slot.lastUsedAt = performance.now();
  if (slot.host.parentNode !== p.container) {
    p.container.appendChild(slot.host);
  }
  setupResizeObserver(slot, p);
  slot.fitAddon.fit();
  slot.lastW = p.container.clientWidth;
  slot.lastH = p.container.clientHeight;
  if (slot.term.cols !== p.cols || slot.term.rows !== p.rows) {
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.term.cols, slot.term.rows);
  }
  slot.lastCols = slot.term.cols;
  slot.lastRows = slot.term.rows;
  p.onSearchReady(slot.searchAddon);
}

function setupResizeObserver(slot: Slot, p: AcquireParams): void {
  slot.observer?.disconnect();
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  const container = p.container;
  const flushPty = () => {
    slot.ptyTimer = null;
    if (slot.currentLeafId !== p.leafId) return;
    if (slot.term.cols === slot.lastCols && slot.term.rows === slot.lastRows)
      return;
    slot.lastCols = slot.term.cols;
    slot.lastRows = slot.term.rows;
    adapter?.resolveLeaf(p.leafId)?.resizePty(slot.lastCols, slot.lastRows);
  };

  slot.observer = new ResizeObserver(() => {
    if (slot.fitTimer) clearTimeout(slot.fitTimer);
    slot.fitTimer = setTimeout(() => {
      slot.fitTimer = null;
      if (slot.currentLeafId !== p.leafId) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === slot.lastW && h === slot.lastH) return;
      slot.lastW = w;
      slot.lastH = h;
      slot.fitAddon.fit();
      if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
      slot.ptyTimer = setTimeout(flushPty, PTY_RESIZE_DEBOUNCE_MS);
    }, FIT_DEBOUNCE_MS);
  });
  slot.observer.observe(container);
}

// Private (DECSET) input modes that a main-screen app sets once and never
// re-asserts — unlike alt-screen TUIs, which repaint (and re-emit their modes)
// on the SIGWINCH kick. The pool's `term.reset()` on reattach wipes these, so
// we capture them at release and replay them after reset/snapshot. Bracketed
// paste (2004) is the important one: without it a multi-line paste loses its
// ESC[200~/201~ wrappers and the app (Claude Code, REPLs) treats every newline
// as Enter — the "only the last line pastes, no [Pasted +N lines]" bug.
export type PreservedModes = {
  bracketedPaste: boolean;
  appCursorKeys: boolean;
  sendFocus: boolean;
};

function captureModes(term: Terminal): PreservedModes {
  const m = term.modes;
  return {
    bracketedPaste: m.bracketedPasteMode,
    appCursorKeys: m.applicationCursorKeysMode,
    sendFocus: m.sendFocusMode,
  };
}

function modeRestoreSequence(modes: PreservedModes | null): string {
  if (!modes) return "";
  let seq = "";
  if (modes.bracketedPaste) seq += "\x1b[?2004h";
  if (modes.appCursorKeys) seq += "\x1b[?1h";
  if (modes.sendFocus) seq += "\x1b[?1004h";
  return seq;
}

export type SerializeOutput = {
  snapshot: string | null;
  modes: PreservedModes;
  cols: number;
  rows: number;
  altScreen: boolean;
};

export function releaseSlot(leafId: number): SerializeOutput | null {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return null;
  const out = serializeSlot(slot);
  detachSlotFromLeaf(slot);
  return out;
}

function serializeSlot(slot: Slot): SerializeOutput {
  let snapshot: string | null = null;
  try {
    const cap = Math.min(
      SNAPSHOT_SCROLLBACK_CAP,
      usePreferencesStore.getState().terminalScrollback,
    );
    snapshot = slot.serializeAddon.serialize({ scrollback: cap });
  } catch (e) {
    console.warn("[terax] serialize failed:", e);
  }
  return {
    snapshot,
    modes: captureModes(slot.term),
    cols: slot.term.cols,
    rows: slot.term.rows,
    altScreen: isAltScreen(slot),
  };
}

function detachSlotFromLeaf(slot: Slot): void {
  for (const d of slot.oscDisposers) {
    try {
      d();
    } catch {}
  }
  slot.oscDisposers = [];

  slot.observer?.disconnect();
  slot.observer = null;
  if (slot.fitTimer) clearTimeout(slot.fitTimer);
  if (slot.ptyTimer) clearTimeout(slot.ptyTimer);
  slot.fitTimer = null;
  slot.ptyTimer = null;

  cancelPendingUnhide(slot);
  slot.host.style.visibility = "";

  if (slot.host.parentNode !== getRecycler()) {
    getRecycler().appendChild(slot.host);
  }

  slot.currentLeafId = null;
  slot.lastUsedAt = performance.now();
}

const WEBGL_RECOVERY_DELAY_MS = 250;
// Below this a re-shown slot is fresh enough to trust; above it, repaint on
// unhide to defeat silent GPU/context staleness.
const SLOT_STALE_MS = 10_000;

function attachWebgl(slot: Slot): void {
  if (slot.webglAddon || !slot.term.element) return;
  if (!usePreferencesStore.getState().terminalWebglEnabled) return;
  const elem = slot.term.element;
  const before = new Set<HTMLCanvasElement>(
    elem.querySelectorAll<HTMLCanvasElement>("canvas"),
  );
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      const cur = slot.webglAddon;
      if (cur === webgl) {
        slot.webglAddon = null;
        slot.webglCanvases = [];
      }
      try {
        webgl.dispose();
      } catch {}
      // Recovery: WebKit may transiently lose contexts on sleep/wake or GPU
      // reset; without re-attach the slot would silently fall back to DOM
      // forever. Defer past WebKit's reset window before retrying.
      setTimeout(() => {
        if (slot.webglAddon) return;
        if (!usePreferencesStore.getState().terminalWebglEnabled) return;
        attachWebgl(slot);
        if (slot.webglAddon) {
          try {
            slot.term.refresh(0, slot.term.rows - 1);
          } catch {}
        }
      }, WEBGL_RECOVERY_DELAY_MS);
    });
    slot.term.loadAddon(webgl);
    const after = elem.querySelectorAll<HTMLCanvasElement>("canvas");
    const added: HTMLCanvasElement[] = [];
    for (const c of after) if (!before.has(c)) added.push(c);
    slot.webglAddon = webgl;
    slot.webglCanvases = added;
  } catch (e) {
    console.warn("[terax-webgl] unavailable:", e);
  }
}

function disposeSlotWebgl(slot: Slot): void {
  if (!slot.webglAddon) return;
  const addon = slot.webglAddon;
  for (const canvas of slot.webglCanvases) releaseCanvasContext(canvas);
  slot.webglCanvases = [];
  try {
    addon.dispose();
  } catch (e) {
    console.warn("[terax-webgl] dispose failed:", e);
  }
  try {
    const r = (
      addon as unknown as { _renderer?: Record<string, unknown> | null }
    )._renderer;
    if (r) {
      r._canvas = null;
      r._gl = null;
      r._charAtlas = null;
      r._atlas = null;
    }
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderer = null;
    (
      addon as unknown as { _renderer?: unknown; _renderService?: unknown }
    )._renderService = null;
  } catch {}
  slot.webglAddon = null;
}

function releaseCanvasContext(canvas: HTMLCanvasElement): void {
  let gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  } catch {}
  if (!gl) {
    try {
      gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    } catch {}
  }
  if (gl) {
    try {
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext && !gl.isContextLost()) ext.loseContext();
    } catch {}
  }
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {}
}

export function applyWebglPreference(enabled: boolean): void {
  for (const slot of slots) {
    if (enabled && !slot.webglAddon) attachWebgl(slot);
    else if (!enabled && slot.webglAddon) disposeSlotWebgl(slot);
  }
}

export function applyFontSize(size: number): void {
  for (const slot of slots) {
    if (slot.term.options.fontSize === size) continue;
    slot.term.options.fontSize = size;
    slot.fitAddon.fit();
    if (slot.currentLeafId !== null) {
      slot.lastCols = slot.term.cols;
      slot.lastRows = slot.term.rows;
      const bridge = adapter?.resolveLeaf(slot.currentLeafId);
      bridge?.resizePty(slot.term.cols, slot.term.rows);
    }
  }
}

export function applyLetterSpacing(spacing: number): void {
  for (const slot of slots) {
    if (slot.term.options.letterSpacing === spacing) continue;
    slot.term.options.letterSpacing = spacing;
    slot.fitAddon.fit();
  }
}

export function applyFontFamily(family: string): void {
  const resolved = family || detectMonoFontFamily();
  for (const slot of slots) {
    if (slot.term.options.fontFamily === resolved) continue;
    slot.term.options.fontFamily = resolved;
    slot.fitAddon.fit();
    if (slot.currentLeafId !== null) {
      slot.lastCols = slot.term.cols;
      slot.lastRows = slot.term.rows;
      const bridge = adapter?.resolveLeaf(slot.currentLeafId);
      bridge?.resizePty(slot.term.cols, slot.term.rows);
    }
  }
}

export function applyScrollback(value: number): void {
  for (const slot of slots) {
    if (slot.term.options.scrollback === value) continue;
    slot.term.options.scrollback = value;
  }
}

export function applyTheme(): void {
  const theme = buildTerminalTheme();
  for (const slot of slots) {
    slot.term.options.theme = theme;
  }
}

export function focusSlot(leafId: number): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  slot?.term.focus();
}

export function setSlotFocused(leafId: number, focused: boolean): void {
  const slot = slots.find((s) => s.currentLeafId === leafId);
  if (!slot) return;
  applyCursorBlinkOnSlot(slot, focused);
}

function applyCursorBlinkOnSlot(slot: Slot, focused: boolean): void {
  const desired = focused;
  if (slot.term.options.cursorBlink === desired) return;
  slot.term.options.cursorBlink = desired;
}

export function getSlotForLeaf(leafId: number): Slot | null {
  return slots.find((s) => s.currentLeafId === leafId) ?? null;
}

const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent);

function isTerminalCopy(e: KeyboardEvent): boolean {
  return (
    !IS_MAC &&
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyC" || e.key === "c" || e.key === "C")
  );
}

function isTerminalPaste(e: KeyboardEvent): boolean {
  return (
    !IS_MAC &&
    e.ctrlKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    (e.code === "KeyV" || e.key === "v" || e.key === "V")
  );
}

function isShiftEnter(e: KeyboardEvent): boolean {
  return (
    e.key === "Enter" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey
  );
}
