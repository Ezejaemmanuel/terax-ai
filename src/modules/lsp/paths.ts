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

export function languageIdForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? (LANGUAGE_BY_EXTENSION[ext] ?? null) : null;
}

export function isLspCandidate(path: string): boolean {
  return languageIdForPath(path) !== null;
}
