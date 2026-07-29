import { beforeEach, describe, expect, it } from "vitest";
import {
  canNavigateBack,
  canNavigateForward,
  forgetNavigation,
  navigateBack,
  navigateForward,
  recordNavigation,
  resetNavigation,
} from "./history";

describe("navigation history", () => {
  beforeEach(() => {
    resetNavigation();
  });

  it("has nowhere to go until two places have been visited", () => {
    expect(navigateBack()).toBeNull();
    recordNavigation({ path: "a.ts" });
    expect(canNavigateBack()).toBe(false);
    recordNavigation({ path: "b.ts" });
    expect(canNavigateBack()).toBe(true);
  });

  it("walks back and forward through visited places", () => {
    recordNavigation({ path: "a.ts" });
    recordNavigation({ path: "b.ts", line: 4 });
    recordNavigation({ path: "c.ts" });

    expect(navigateBack()).toEqual({ path: "b.ts", line: 4 });
    expect(navigateBack()).toEqual({ path: "a.ts" });
    expect(navigateBack()).toBeNull();
    expect(navigateForward()).toEqual({ path: "b.ts", line: 4 });
    expect(navigateForward()).toEqual({ path: "c.ts" });
    expect(canNavigateForward()).toBe(false);
  });

  it("returns to the line the user left, not the one they arrived on", () => {
    recordNavigation({ path: "a.ts", line: 1 });
    // Jumped to a definition from line 42 of the same file's earlier visit.
    recordNavigation({ path: "b.ts", line: 9 }, 42);
    expect(navigateBack()).toEqual({ path: "a.ts", line: 42 });
  });

  it("drops the forward trail once a new place is visited", () => {
    recordNavigation({ path: "a.ts" });
    recordNavigation({ path: "b.ts" });
    navigateBack();
    expect(canNavigateForward()).toBe(true);
    recordNavigation({ path: "c.ts" });
    expect(canNavigateForward()).toBe(false);
    expect(navigateBack()).toEqual({ path: "a.ts" });
  });

  it("ignores a repeat of the place already showing", () => {
    recordNavigation({ path: "a.ts", line: 3 });
    recordNavigation({ path: "a.ts", line: 3 });
    expect(canNavigateBack()).toBe(false);
  });

  it("forgets a deleted file", () => {
    recordNavigation({ path: "a.ts" });
    recordNavigation({ path: "gone.ts" });
    recordNavigation({ path: "b.ts" });
    forgetNavigation("gone.ts");
    expect(navigateBack()).toEqual({ path: "a.ts" });
  });
});
