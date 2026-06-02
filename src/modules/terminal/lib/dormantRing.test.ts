import { describe, expect, it } from "vitest";
import { DormantRing, dormantByteCapForScrollback } from "./dormantRing";

const enc = (s: string) => new TextEncoder().encode(s);

function drainToString(ring: DormantRing): string {
  const parts: string[] = [];
  ring.drain((bytes) => parts.push(new TextDecoder().decode(bytes)));
  return parts.join("");
}

describe("dormantByteCapForScrollback", () => {
  it("never drops below the 256 KB floor", () => {
    expect(dormantByteCapForScrollback(0)).toBe(256 * 1024);
    expect(dormantByteCapForScrollback(100)).toBe(256 * 1024);
  });

  it("scales with the scrollback line count", () => {
    expect(dormantByteCapForScrollback(10_000)).toBe(10_000 * 512);
    expect(dormantByteCapForScrollback(50_000)).toBe(50_000 * 512);
  });

  it("tolerates non-finite input", () => {
    expect(dormantByteCapForScrollback(NaN)).toBe(256 * 1024);
  });
});

describe("DormantRing", () => {
  it("retains everything when under the cap and adds no notice", () => {
    const ring = new DormantRing(1024, 1024);
    ring.push(enc("hello "));
    ring.push(enc("world"));
    expect(drainToString(ring)).toBe("hello world");
  });

  it("keeps only the most recent bytes once the byte cap is exceeded", () => {
    const ring = new DormantRing(10, 1024);
    ring.push(enc("aaaa"));
    ring.push(enc("bbbb"));
    ring.push(enc("cccc"));
    const out = drainToString(ring);
    expect(out).toContain("dropped output during hibernation");
    expect(out).toContain("cccc");
    expect(out).not.toContain("aaaa");
  });

  it("setByteCap shrinks live and evicts the oldest chunks", () => {
    const ring = new DormantRing(1024, 1024);
    ring.push(enc("aaaa"));
    ring.push(enc("bbbb"));
    ring.push(enc("cccc"));
    ring.setByteCap(8);
    const out = drainToString(ring);
    expect(out).toContain("cccc");
    expect(out).not.toContain("aaaa");
  });

  it("drain resets the ring so a second drain yields nothing", () => {
    const ring = new DormantRing(1024, 1024);
    ring.push(enc("data"));
    drainToString(ring);
    expect(drainToString(ring)).toBe("");
  });
});
