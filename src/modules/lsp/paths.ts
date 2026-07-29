/** Files the TypeScript server has anything to say about. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
};

/**
 * Directories the server is never told about. Dependencies and build output are
 * the bulk of the files in a project and the ones nobody edits, so opening them
 * would cost a full round trip and a retained copy of the text for nothing.
 * Matched as whole path segments, so a project named `dist-tools` is spared.
 */
const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".svelte-kit",
  ".output",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
]);

export function languageIdForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? (LANGUAGE_BY_EXTENSION[ext] ?? null) : null;
}

export function isIgnoredPath(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => IGNORED_SEGMENTS.has(segment));
}

export function isLspCandidate(path: string): boolean {
  return languageIdForPath(path) !== null && !isIgnoredPath(path);
}
