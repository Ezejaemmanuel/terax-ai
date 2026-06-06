import { describe, expect, it } from "vitest";
import { isDescendantOrSelf, parentDir } from "./explorerDnd";

describe("isDescendantOrSelf", () => {
  it("rejects dropping a folder onto itself", () => {
    expect(isDescendantOrSelf("/a/b", "/a/b")).toBe(true);
  });

  it("rejects dropping into a descendant", () => {
    expect(isDescendantOrSelf("/a/b/c", "/a/b")).toBe(true);
  });

  it("allows dropping into a sibling or unrelated folder", () => {
    expect(isDescendantOrSelf("/a/c", "/a/b")).toBe(false);
    expect(isDescendantOrSelf("/x/y", "/a/b")).toBe(false);
  });

  it("allows dropping into the parent (a real move)", () => {
    expect(isDescendantOrSelf("/a", "/a/b")).toBe(false);
  });

  it("does not treat a name-prefix sibling as a descendant", () => {
    // "/a/bee" must not count as inside "/a/b".
    expect(isDescendantOrSelf("/a/bee", "/a/b")).toBe(false);
  });

  it("normalizes Windows backslashes before comparing", () => {
    expect(isDescendantOrSelf("C:\\a\\b\\c", "C:\\a\\b")).toBe(true);
    expect(isDescendantOrSelf("C:\\a\\c", "C:\\a\\b")).toBe(false);
  });
});

describe("parentDir", () => {
  it("returns the containing directory", () => {
    expect(parentDir("/a/b/c.txt", "/root")).toBe("/a/b");
  });

  it("falls back when there is no real parent", () => {
    expect(parentDir("/a", "/root")).toBe("/root");
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(parentDir("C:\\a\\b\\c.txt", "C:/root")).toBe("C:/a/b");
  });
});
