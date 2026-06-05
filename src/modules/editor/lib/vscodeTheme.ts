// Types + tolerant parsing for imported VSCode theme files. The actual syntax
// highlighting is done by Shiki (see ./shiki) using the raw theme JSON; this
// module only validates and normalizes the uploaded file.

export type VsCodeThemeJson = {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: Array<{
    name?: string;
    scope?: string | string[];
    settings?: { foreground?: string; background?: string; fontStyle?: string };
  }>;
  semanticTokenColors?: Record<string, unknown>;
  semanticHighlighting?: boolean;
};

// Strip // and /* */ comments respecting string literals, then drop trailing
// commas. Many shipped VSCode themes are JSONC, which JSON.parse rejects.
function stripJsonc(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  let inStr = false;
  while (i < n) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += s[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") {
      i += 2;
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export type ParseResult =
  | { ok: true; json: VsCodeThemeJson; name: string | null }
  | { ok: false; error: string };

function validateObject(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Expected a JSON object." };
  }
  const obj = raw as Record<string, unknown>;
  const hasColors =
    typeof obj["colors"] === "object" && obj["colors"] !== null;
  const hasTokens =
    Array.isArray(obj["tokenColors"]) &&
    (obj["tokenColors"] as unknown[]).length > 0;
  if (!hasColors && !hasTokens) {
    return {
      ok: false,
      error: "Missing both 'colors' and 'tokenColors' — not a VSCode theme.",
    };
  }
  const name =
    typeof obj["name"] === "string" && obj["name"].trim()
      ? obj["name"].trim()
      : null;
  return { ok: true, json: obj as VsCodeThemeJson, name };
}

/** Parse uploaded theme text (JSON or JSONC). `name` may be null — many valid
 *  theme files keep the display name in package.json, so callers should fall
 *  back to the filename. */
export function parseVsCodeThemeText(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = JSON.parse(stripJsonc(text));
    } catch (e) {
      return {
        ok: false,
        error: `Not valid JSON/JSONC: ${e instanceof Error ? e.message : "parse error"}`,
      };
    }
  }
  return validateObject(parsed);
}
