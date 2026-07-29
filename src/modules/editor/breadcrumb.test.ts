import { describe, expect, it } from "vitest";
import { buildTrail } from "./Breadcrumb";

describe("buildTrail", () => {
  it("shows the path relative to the workspace root", () => {
    expect(buildTrail("C:/work/app/src/mastra/agent.ts", "C:/work/app")).toEqual([
      "src",
      "mastra",
      "agent.ts",
    ]);
  });

  it("accepts backslashes and a trailing separator on the root", () => {
    expect(buildTrail("C:\\work\\app\\src\\a.ts", "C:\\work\\app\\")).toEqual([
      "src",
      "a.ts",
    ]);
  });

  it("falls back to the whole path for a file outside the root", () => {
    expect(buildTrail("/etc/hosts", "/home/me/app")).toEqual(["etc", "hosts"]);
  });

  it("works without a root", () => {
    expect(buildTrail("/home/me/a.ts")).toEqual(["home", "me", "a.ts"]);
    expect(buildTrail("/home/me/a.ts", null)).toEqual(["home", "me", "a.ts"]);
  });
});
