import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { isLspCandidate, languageIdForPath } from "./paths";
import { normalizeRoot, rootForPathIn, type LspEnablement } from "./store";
import { toCodeMirrorDiagnostics } from "./editorExtension";

describe("normalizeRoot", () => {
  it("uses forward slashes and drops the trailing one", () => {
    expect(normalizeRoot("C:\\Users\\me\\app\\")).toBe("C:/Users/me/app");
  });

  it("keeps a bare root separator", () => {
    expect(normalizeRoot("/")).toBe("/");
  });
});

describe("rootForPathIn", () => {
  const enabled: Record<string, LspEnablement> = {
    "C:/work/app": "session",
    "C:/work/app/packages/ui": "persistent",
  };

  it("picks the innermost enabled project", () => {
    expect(rootForPathIn(enabled, "C:/work/app/packages/ui/src/a.ts")).toBe(
      "C:/work/app/packages/ui",
    );
  });

  it("falls back to the outer project", () => {
    expect(rootForPathIn(enabled, "C:/work/app/src/a.ts")).toBe("C:/work/app");
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(rootForPathIn(enabled, "C:/work/app-two/src/a.ts")).toBeNull();
  });

  it("returns null when nothing is enabled", () => {
    expect(rootForPathIn({}, "C:/work/app/src/a.ts")).toBeNull();
  });
});

describe("languageIdForPath", () => {
  it("maps the TypeScript and JavaScript dialects", () => {
    expect(languageIdForPath("a/b.tsx")).toBe("typescriptreact");
    expect(languageIdForPath("a/b.MTS")).toBe("typescript");
    expect(languageIdForPath("a/b.cjs")).toBe("javascript");
  });

  it("ignores everything else", () => {
    expect(languageIdForPath("a/b.rs")).toBeNull();
    expect(isLspCandidate("a/b.md")).toBe(false);
  });
});

describe("toCodeMirrorDiagnostics", () => {
  const state = EditorState.create({ doc: "const a = 1;\nconst b = 2;\n" });

  it("converts zero-based positions to offsets", () => {
    const [diagnostic] = toCodeMirrorDiagnostics(state, [
      {
        startLine: 1,
        startCharacter: 6,
        endLine: 1,
        endCharacter: 7,
        severity: 1,
        code: "2322",
        source: "ts",
        message: "bad",
      },
    ]);
    expect(diagnostic.from).toBe(19);
    expect(diagnostic.to).toBe(20);
    expect(diagnostic.severity).toBe("error");
    expect(diagnostic.source).toBe("ts(2322)");
  });

  it("widens an empty range so there is something to underline", () => {
    const [diagnostic] = toCodeMirrorDiagnostics(state, [
      {
        startLine: 0,
        startCharacter: 0,
        endLine: 0,
        endCharacter: 0,
        severity: 2,
        code: null,
        source: null,
        message: "warn",
      },
    ]);
    expect(diagnostic.from).toBe(0);
    expect(diagnostic.to).toBe(1);
    expect(diagnostic.severity).toBe("warning");
  });

  it("clamps positions past the end of the document", () => {
    const [diagnostic] = toCodeMirrorDiagnostics(state, [
      {
        startLine: 99,
        startCharacter: 99,
        endLine: 99,
        endCharacter: 99,
        severity: 3,
        code: null,
        source: null,
        message: "info",
      },
    ]);
    expect(diagnostic.from).toBeLessThanOrEqual(state.doc.length);
    expect(diagnostic.to).toBeLessThanOrEqual(state.doc.length);
  });
});
