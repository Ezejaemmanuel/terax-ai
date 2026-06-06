import { describe, expect, it } from "vitest";
import { pathRange } from "./useSelection";

const ORDER = ["a", "b", "c", "d", "e"];

describe("pathRange", () => {
  it("returns the inclusive slice when anchor precedes the target", () => {
    expect(pathRange(ORDER, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("is order-independent (target before anchor)", () => {
    expect(pathRange(ORDER, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("returns a single element when anchor equals target", () => {
    expect(pathRange(ORDER, "c", "c")).toEqual(["c"]);
  });

  it("spans the whole list across the endpoints", () => {
    expect(pathRange(ORDER, "a", "e")).toEqual(ORDER);
  });

  it("degenerates to just the target when the anchor is gone", () => {
    expect(pathRange(ORDER, "missing", "c")).toEqual(["c"]);
  });

  it("degenerates to just the target when the target is gone", () => {
    expect(pathRange(ORDER, "b", "missing")).toEqual(["missing"]);
  });
});
