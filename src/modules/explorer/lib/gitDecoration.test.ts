import { describe, expect, it } from "vitest";
import type { GitChangedFile } from "@/modules/ai/lib/native";
import {
  badgeFor,
  buildDecorationMap,
  colorClassFor,
  joinRepoPath,
  mapChangedFile,
  normalizePath,
  type GitFileStatus,
} from "./gitDecoration";

function file(overrides: Partial<GitChangedFile>): GitChangedFile {
  return {
    path: "a.txt",
    originalPath: null,
    indexStatus: " ",
    worktreeStatus: " ",
    staged: false,
    unstaged: false,
    untracked: false,
    statusLabel: "",
    ...overrides,
  };
}

describe("mapChangedFile", () => {
  it("flags untracked files regardless of codes", () => {
    expect(mapChangedFile(file({ untracked: true, worktreeStatus: "?" }))).toBe(
      "untracked",
    );
  });

  it("maps single porcelain codes", () => {
    expect(mapChangedFile(file({ worktreeStatus: "M" }))).toBe("modified");
    expect(mapChangedFile(file({ indexStatus: "A" }))).toBe("added");
    expect(mapChangedFile(file({ worktreeStatus: "D" }))).toBe("deleted");
    expect(mapChangedFile(file({ indexStatus: "R" }))).toBe("renamed");
    expect(mapChangedFile(file({ indexStatus: "C" }))).toBe("added");
    expect(mapChangedFile(file({ worktreeStatus: "T" }))).toBe("modified");
  });

  it("treats unmerged 'U' as a conflict", () => {
    expect(mapChangedFile(file({ indexStatus: "U", worktreeStatus: "U" }))).toBe(
      "conflict",
    );
  });

  it("picks the strongest interpretation across index + worktree", () => {
    // staged-added (A) but worktree-modified (M) → modified outranks added
    expect(mapChangedFile(file({ indexStatus: "A", worktreeStatus: "M" }))).toBe(
      "modified",
    );
    // worktree deleted outranks staged modified
    expect(mapChangedFile(file({ indexStatus: "M", worktreeStatus: "D" }))).toBe(
      "deleted",
    );
    // a staged rename further edited in the worktree still reads as a rename
    expect(mapChangedFile(file({ indexStatus: "R", worktreeStatus: "M" }))).toBe(
      "renamed",
    );
  });

  it("falls back to modified for unrecognized-but-present codes", () => {
    expect(mapChangedFile(file({ worktreeStatus: "X" }))).toBe("modified");
  });
});

describe("badge + color helpers", () => {
  it("returns a single-letter badge per status", () => {
    const cases: Array<[GitFileStatus, string]> = [
      ["modified", "M"],
      ["added", "A"],
      ["deleted", "D"],
      ["untracked", "U"],
      ["renamed", "R"],
      ["conflict", "C"],
    ];
    for (const [status, badge] of cases) expect(badgeFor(status)).toBe(badge);
  });

  it("returns a tailwind color class per status", () => {
    expect(colorClassFor("modified")).toBe("text-git-modified");
    expect(colorClassFor("untracked")).toBe("text-git-untracked");
  });
});

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("C:\\Users\\x\\a.ts", false)).toBe("C:/Users/x/a.ts");
  });

  it("strips a trailing slash but preserves root", () => {
    expect(normalizePath("/a/b/", false)).toBe("/a/b");
    expect(normalizePath("/", false)).toBe("/");
  });

  it("case-folds when case-insensitive", () => {
    expect(normalizePath("C:/Users/X/A.TS", true)).toBe("c:/users/x/a.ts");
    expect(normalizePath("C:/Users/X/A.TS", false)).toBe("C:/Users/X/A.TS");
  });
});

describe("joinRepoPath", () => {
  it("joins root and relative path with a single slash", () => {
    expect(joinRepoPath("/repo", "src/a.ts")).toBe("/repo/src/a.ts");
  });

  it("normalizes separators and trims stray slashes", () => {
    expect(joinRepoPath("C:\\repo\\", "\\src\\a.ts")).toBe("C:/repo/src/a.ts");
  });
});

describe("buildDecorationMap", () => {
  it("decorates files and propagates to ancestor folders up to the repo root", () => {
    const map = buildDecorationMap(
      "/repo",
      [file({ path: "src/app/a.ts", worktreeStatus: "M" })],
      false,
    );

    expect(map.get("/repo/src/app/a.ts")).toEqual({
      status: "modified",
      badge: "M",
      isDir: false,
    });
    expect(map.get("/repo/src/app")?.isDir).toBe(true);
    expect(map.get("/repo/src/app")?.status).toBe("modified");
    expect(map.get("/repo/src")?.status).toBe("modified");
    // The repo root itself is not decorated.
    expect(map.get("/repo")).toBeUndefined();
  });

  it("aggregates the strongest descendant status onto a folder", () => {
    const map = buildDecorationMap(
      "/repo",
      [
        file({ path: "src/a.ts", worktreeStatus: "M" }), // modified
        file({ path: "src/b.ts", untracked: true }), // untracked (weaker)
        file({ path: "src/c.ts", worktreeStatus: "U" }), // conflict (strongest)
      ],
      false,
    );
    expect(map.get("/repo/src")?.status).toBe("conflict");
  });

  it("keeps individual file statuses distinct from the aggregated folder", () => {
    const map = buildDecorationMap(
      "/repo",
      [
        file({ path: "src/a.ts", untracked: true }),
        file({ path: "src/d/e.ts", worktreeStatus: "D" }),
      ],
      false,
    );
    expect(map.get("/repo/src/a.ts")?.status).toBe("untracked");
    expect(map.get("/repo/src/d/e.ts")?.status).toBe("deleted");
    expect(map.get("/repo/src/d")?.status).toBe("deleted");
    // /repo/src aggregates deleted (5) over untracked (1)
    expect(map.get("/repo/src")?.status).toBe("deleted");
  });

  it("never tags the repo root itself as a changed file", () => {
    const map = buildDecorationMap(
      "/repo",
      [file({ path: "", worktreeStatus: "M" })],
      false,
    );
    expect(map.get("/repo")).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it("matches paths case-insensitively when requested", () => {
    const map = buildDecorationMap(
      "C:/Repo",
      [file({ path: "Src/A.ts", worktreeStatus: "M" })],
      true,
    );
    expect(map.get("c:/repo/src/a.ts")?.status).toBe("modified");
    expect(map.get("c:/repo/src")?.status).toBe("modified");
  });
});
