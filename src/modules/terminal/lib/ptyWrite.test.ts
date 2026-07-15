import { describe, expect, it } from "vitest";
import { ptyWriteChunks } from "./pty-bridge";

describe("ptyWriteChunks", () => {
  it("passes a keystroke through as a single chunk", () => {
    expect(ptyWriteChunks("a")).toEqual(["a"]);
    expect(ptyWriteChunks("\x1b[A")).toEqual(["\x1b[A"]);
  });

  it("returns one chunk exactly at the boundary", () => {
    const data = "x".repeat(1024);
    expect(ptyWriteChunks(data)).toEqual([data]);
  });

  it("splits an oversized paste into ordered chunks that never exceed the cap", () => {
    const data = "y".repeat(1024 * 3 + 7);
    const chunks = ptyWriteChunks(data);
    expect(chunks).toHaveLength(4);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1024);
    // No bytes dropped or reordered: reassembly is byte-for-byte the original.
    expect(chunks.join("")).toBe(data);
  });

  it("keeps a bracketed-paste payload intact across chunk boundaries", () => {
    const body = "line\r".repeat(500);
    const payload = `\x1b[200~${body}\x1b[201~`;
    const chunks = ptyWriteChunks(payload, 64);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(64);
    const joined = chunks.join("");
    expect(joined.startsWith("\x1b[200~")).toBe(true);
    expect(joined.endsWith("\x1b[201~")).toBe(true);
    expect(joined).toBe(payload);
  });

  it("honors a custom chunk size", () => {
    expect(ptyWriteChunks("abcde", 2)).toEqual(["ab", "cd", "e"]);
  });
});
