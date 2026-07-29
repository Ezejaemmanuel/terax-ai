import { describe, expect, it } from "vitest";
import { parseHoverMarkdown } from "./hoverContent";

describe("parseHoverMarkdown", () => {
  it("separates the fenced signature from the doc comment", () => {
    const blocks = parseHoverMarkdown(
      "```typescript\nfunction normalizeRoot(root: string): string\n```\nNormalizes a project root.",
    );
    expect(blocks).toEqual([
      { kind: "code", text: "function normalizeRoot(root: string): string" },
      { kind: "text", spans: [{ text: "Normalizes a project root.", code: false }] },
    ]);
  });

  it("keeps inline code and drops emphasis and link syntax", () => {
    const blocks = parseHoverMarkdown("*@param* `root` see [the docs](http://x/y)");
    expect(blocks).toEqual([
      {
        kind: "text",
        spans: [
          { text: "@param ", code: false },
          { text: "root", code: true },
          { text: " see the docs", code: false },
        ],
      },
    ]);
  });

  it("drops the rule a server puts between signature and docs", () => {
    const blocks = parseHoverMarkdown("```ts\nconst a: 1\n```\n\n---\n\nThe number one.");
    expect(blocks.map((b) => b.kind)).toEqual(["code", "text"]);
  });

  it("treats a plaintext answer as one prose block", () => {
    expect(parseHoverMarkdown("function foo(): void")).toEqual([
      { kind: "text", spans: [{ text: "function foo(): void", code: false }] },
    ]);
  });

  it("yields nothing for empty content", () => {
    expect(parseHoverMarkdown("   \n\n")).toEqual([]);
  });

  it("keeps an unterminated fence's body", () => {
    expect(parseHoverMarkdown("```ts\nlet x = 1")).toEqual([
      { kind: "code", text: "let x = 1" },
    ]);
  });
});
