import { describe, expect, it } from "vitest";
import {
  scanBracketedPaste,
  type BracketedScan,
} from "@/modules/terminal/lib/useTerminalSession";

const START: BracketedScan = { state: false, matched: 0 };

const bytes = (s: string) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));

// Feed a sequence of chunks through the scanner the way deliverPtyBytes does,
// carrying state between reads.
function feed(chunks: string[], from: BracketedScan = START): BracketedScan {
  return chunks.reduce((acc, c) => scanBracketedPaste(bytes(c), acc), from);
}

describe("scanBracketedPaste", () => {
  it("detects enable in a single chunk", () => {
    expect(feed(["\x1b[?2004h"]).state).toBe(true);
  });

  it("detects disable in a single chunk", () => {
    expect(feed(["\x1b[?2004h", "\x1b[?2004l"]).state).toBe(false);
  });

  it("ignores unrelated output", () => {
    expect(feed(["hello world\r\n$ "]).state).toBe(false);
  });

  it("leaves state untouched by other CSI sequences", () => {
    expect(feed(["\x1b[?2004h", "\x1b[2J\x1b[?25l\x1b[1;1H"]).state).toBe(true);
  });

  // The regression this scanner exists for. Claude Code toggles 2004 while
  // redrawing, so the sequence lands mid-burst and the pty splits it anywhere.
  it("detects an enable split across two reads at every offset", () => {
    const seq = "\x1b[?2004h";
    for (let cut = 1; cut < seq.length; cut++) {
      const result = feed([seq.slice(0, cut), seq.slice(cut)]);
      expect(result.state, `split after ${cut} byte(s)`).toBe(true);
    }
  });

  it("detects an enable split byte by byte", () => {
    expect(feed("\x1b[?2004h".split("")).state).toBe(true);
  });

  it("detects a re-enable split across reads inside surrounding output", () => {
    // Disable, then a large redraw burst whose tail carries a re-enable that is
    // cut in half by the read boundary. The old per-chunk scanner missed this
    // and latched false for the rest of the session.
    const result = feed([
      "\x1b[?2004l",
      `${"x".repeat(4096)}\x1b[?20`,
      `04h${"y".repeat(2048)}`,
    ]);
    expect(result.state).toBe(true);
  });

  it("does not latch false once a boundary-split re-enable arrives", () => {
    const afterMiss = feed(["\x1b[?2004h", "\x1b[?2004l"]);
    expect(afterMiss.state).toBe(false);
    expect(feed(["\x1b[?2", "004h"], afterMiss).state).toBe(true);
  });

  it("recovers when a false start is followed by a real sequence", () => {
    // ESC that does not continue into the prefix must not swallow the ESC of a
    // genuine sequence that follows immediately.
    expect(feed(["\x1bM\x1b[?2004h"]).state).toBe(true);
    expect(feed(["\x1b[?20", "\x1b[?2004h"]).state).toBe(true);
  });

  it("treats an incomplete trailing prefix as pending, not a match", () => {
    const pending = feed(["\x1b[?2004"]);
    expect(pending.state).toBe(false);
    expect(pending.matched).toBe(7);
    // The very next byte decides it.
    expect(scanBracketedPaste(bytes("h"), pending).state).toBe(true);
    expect(scanBracketedPaste(bytes("l"), pending).state).toBe(false);
  });

  it("ignores a completed prefix followed by a non-h/l final byte", () => {
    const on = feed(["\x1b[?2004h"]);
    expect(scanBracketedPaste(bytes("\x1b[?2004$"), on).state).toBe(true);
  });

  it("applies the last toggle when a chunk holds several", () => {
    expect(feed(["\x1b[?2004h\x1b[?2004l\x1b[?2004h"]).state).toBe(true);
    expect(feed(["\x1b[?2004l\x1b[?2004h\x1b[?2004l"]).state).toBe(false);
  });

  it("handles an empty read without disturbing pending state", () => {
    const pending = feed(["\x1b[?20"]);
    const after = scanBracketedPaste(new Uint8Array(0), pending);
    expect(after).toEqual(pending);
    expect(feed(["04h"], after).state).toBe(true);
  });
});
