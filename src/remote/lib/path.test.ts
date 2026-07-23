import { describe, expect, it } from "vitest";
import { toRelativePath } from "@/remote/lib/path";

describe("toRelativePath", () => {
  it("strips the cwd prefix on a nested file", () => {
    expect(toRelativePath("C:\\proj\\src\\a.ts", "C:\\proj")).toBe("src/a.ts");
  });

  it("is case-insensitive on Windows-style paths", () => {
    expect(toRelativePath("c:/Proj/Src/A.ts", "C:\\proj")).toBe("Src/A.ts");
  });

  it("returns '.' when the path is exactly the cwd", () => {
    expect(toRelativePath("/home/dev/app", "/home/dev/app/")).toBe(".");
  });

  it("leaves a path outside cwd untouched", () => {
    expect(toRelativePath("/other/place/x.ts", "/home/dev/app")).toBe(
      "/other/place/x.ts",
    );
  });

  it("passes through when cwd or path is missing", () => {
    expect(toRelativePath("a.ts", "")).toBe("a.ts");
    expect(toRelativePath("", "/home/dev")).toBe("");
  });
});
