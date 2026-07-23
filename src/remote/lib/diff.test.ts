import { describe, expect, it } from "vitest";
import { collapseContext, diffLines } from "@/remote/lib/diff";

describe("diffLines", () => {
  it("marks every line as added when there is no old text", () => {
    const rows = diffLines("", "a\nb");
    expect(rows).toEqual([
      { type: "add", text: "a" },
      { type: "add", text: "b" },
    ]);
  });

  it("marks every line as removed when there is no new text", () => {
    const rows = diffLines("a\nb", "");
    expect(rows).toEqual([
      { type: "del", text: "a" },
      { type: "del", text: "b" },
    ]);
  });

  it("returns pure context for identical text", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.type === "ctx")).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["a", "b", "c"]);
  });

  it("finds a single-line change inside a larger unchanged block", () => {
    const rows = diffLines("a\nb\nc\nd", "a\nX\nc\nd");
    expect(rows).toEqual([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "X" },
      { type: "ctx", text: "c" },
      { type: "ctx", text: "d" },
    ]);
  });

  it("handles pure insertions in the middle", () => {
    const rows = diffLines("a\nc", "a\nb\nc");
    expect(rows).toEqual([
      { type: "ctx", text: "a" },
      { type: "add", text: "b" },
      { type: "ctx", text: "c" },
    ]);
  });
});

describe("collapseContext", () => {
  it("leaves short unchanged runs alone", () => {
    const lines = diffLines("a\nb\nX", "a\nb\nY");
    const collapsed = collapseContext(lines, 3);
    expect(collapsed.some((r) => "count" in r)).toBe(false);
  });

  it("collapses a long unchanged run down to a gap plus context", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const newLines = [...oldLines];
    newLines[10] = "changed";
    const rows = diffLines(oldLines.join("\n"), newLines.join("\n"));
    const collapsed = collapseContext(rows, 2);

    const gap = collapsed.find((r) => "count" in r);
    expect(gap).toBeDefined();
    // 10 lines of prefix context (0..9) minus 2 kept = 8 hidden,
    // 9 lines of suffix context (11..19) minus 2 kept = 7 hidden.
    expect((gap as { count: number }).count).toBeGreaterThan(0);
    expect(collapsed.some((r) => "type" in r && r.type === "del" && r.text === "line10")).toBe(
      true,
    );
  });
});
