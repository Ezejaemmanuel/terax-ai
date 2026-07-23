import { memo, useEffect, useMemo, useState } from "react";
import { Streamdown } from "streamdown";
import {
  CheckListIcon,
  Edit02Icon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderOpenIcon,
  GlobalSearchIcon,
  RobotIcon,
  SparklesIcon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { DiffView } from "@/remote/components/DiffView";
import { toRelativePath } from "@/remote/lib/path";
import { useSessionCwd } from "@/remote/lib/sessionContext";
import type { ToolRowBlock } from "@/remote/lib/mergeTranscript";

type HugeIcon = Parameters<typeof HugeiconsIcon>[0]["icon"];

/// Claude, Command Code, and Cursor each name their tools differently (e.g.
/// `Read` vs `read_file` vs `read`), so exact-name lookups miss two of the
/// three agents. Matching by substring on the lowercased name gets a sane
/// icon/label for any agent's file/shell/search tool without having to know
/// every agent's exact vocabulary.
const CATEGORY_MATCHERS: { test: RegExp; label: string; icon: HugeIcon }[] = [
  { test: /write|create/, label: "Write", icon: FilePlusIcon },
  { test: /multiedit/, label: "Edit", icon: Edit02Icon },
  { test: /notebook/, label: "Notebook", icon: FileEditIcon },
  { test: /edit/, label: "Edit", icon: FileEditIcon },
  { test: /read|^cat$|view/, label: "Read", icon: File01Icon },
  { test: /bash|shell|terminal|^run/, label: "Run", icon: TerminalIcon },
  { test: /grep|codebase.?search|search/, label: "Search", icon: GlobalSearchIcon },
  { test: /glob/, label: "Glob", icon: Folder01Icon },
  { test: /list.?dir|^ls$/, label: "List", icon: FolderOpenIcon },
  { test: /fetch/, label: "Fetch", icon: GlobalSearchIcon },
  { test: /task|subagent|delegate/, label: "Subagent", icon: RobotIcon },
  { test: /todo/, label: "Todos", icon: CheckListIcon },
  { test: /plan/, label: "Plan", icon: SparklesIcon },
];

function toolMeta(name: string): { label: string; icon: HugeIcon } {
  const lower = name.toLowerCase();
  for (const m of CATEGORY_MATCHERS) {
    if (m.test.test(lower)) return { label: m.label, icon: m.icon };
  }
  return { label: name, icon: ToolsIcon };
}

/// True for anything classified as a file mutation (Write/Edit/MultiEdit/
/// NotebookEdit and each agent's equivalent). These get a diff instead of a
/// raw JSON dump, and open by default: seeing what changed matters more here
/// than for a read or a search.
function isFileEditTool(name: string): boolean {
  const { label } = toolMeta(name);
  return label === "Write" || label === "Edit" || label === "Notebook";
}

const OLD_TEXT_KEYS = ["old_string", "old_str", "old_text", "original_text"];
const NEW_TEXT_KEYS = ["new_string", "new_str", "new_text", "replacement_text"];
const FULL_CONTENT_KEYS = ["content", "new_source", "file_text", "text"];

type EditPreview =
  | { kind: "replace"; old: string; next: string }
  | { kind: "write"; content: string }
  | { kind: "multi"; edits: { old: string; next: string }[] };

/// Best-effort extraction of an edit's before/after text straight from the
/// tool call's input, without needing a copy of the file as it existed
/// before the edit (the transcript never carries one). Claude's `Edit` /
/// `MultiEdit` and most agents' equivalents give us that directly via
/// old/new string pairs; `Write` only gives the new content, so it renders
/// as an add-only diff.
function extractEdit(obj: Record<string, unknown> | null): EditPreview | null {
  if (!obj) return null;
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : null);

  if (Array.isArray(obj.edits)) {
    const edits = (obj.edits as unknown[])
      .map((e) => {
        if (!e || typeof e !== "object") return null;
        const r = e as Record<string, unknown>;
        const old = typeof r.old_string === "string" ? r.old_string : null;
        const next = typeof r.new_string === "string" ? r.new_string : null;
        return old !== null && next !== null ? { old, next } : null;
      })
      .filter((e): e is { old: string; next: string } => e !== null);
    if (edits.length) return { kind: "multi", edits };
  }

  for (const ok of OLD_TEXT_KEYS) {
    const old = str(ok);
    if (old === null) continue;
    for (const nk of NEW_TEXT_KEYS) {
      const next = str(nk);
      if (next !== null) return { kind: "replace", old, next };
    }
  }

  for (const ck of FULL_CONTENT_KEYS) {
    const content = str(ck);
    if (content !== null) return { kind: "write", content };
  }

  return null;
}

/// Keys different agents use for "the path this tool touched". Checked in
/// order so a more specific key (e.g. `notebook_path`) wins over a generic
/// one if a tool somehow has both.
const PATH_KEYS = [
  "file_path",
  "filePath",
  "notebook_path",
  "target_file",
  "path",
  "directory",
  "dir_path",
  "folder",
];

function parseInput(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstLine(s: string, max = 72) {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/// Keys that hold a shell command / search query / URL — kept verbatim
/// (not treated as a path) since they aren't relative to the project root.
const VERBATIM_KEYS = [
  "command",
  "cmd",
  "script",
  "bash_id",
  "pattern",
  "glob_pattern",
  "search_pattern",
  "query",
  "url",
];

function deriveSummary(name: string, inputText: string, cwd: string | null): string {
  const obj = parseInput(inputText);
  if (!obj) return firstLine(inputText);
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : null);

  for (const key of PATH_KEYS) {
    const v = str(key);
    if (v) return toRelativePath(v, cwd);
  }
  for (const key of VERBATIM_KEYS) {
    const v = str(key);
    if (v) return v.length > 90 ? firstLine(v, 90) : v;
  }

  const lower = name.toLowerCase();
  if (lower.includes("task") || lower.includes("subagent")) {
    return str("description") ?? str("subagent_type") ?? firstLine(inputText);
  }
  if (lower.includes("todo")) {
    const todos = Array.isArray(obj.todos) ? obj.todos : null;
    if (todos) return `${todos.length} item${todos.length === 1 ? "" : "s"}`;
  }
  return firstLine(inputText);
}

export const ToolCard = memo(function ToolCard({
  block,
  defaultOpen,
}: {
  block: ToolRowBlock;
  defaultOpen: boolean;
}) {
  const cwd = useSessionCwd();
  const { label, icon: Icon } = toolMeta(block.name);
  const summary = deriveSummary(block.name, block.input, cwd);
  const inputObj = useMemo(() => parseInput(block.input), [block.input]);
  const editPreview = useMemo(
    () => (isFileEditTool(block.name) ? extractEdit(inputObj) : null),
    [block.name, inputObj],
  );

  // File edits open by default regardless of the accordion setting: seeing
  // what changed is the point, not something to dig for.
  const effectiveDefaultOpen = defaultOpen || editPreview !== null;
  const [open, setOpen] = useState(effectiveDefaultOpen);
  useEffect(() => {
    setOpen(effectiveDefaultOpen);
  }, [effectiveDefaultOpen]);

  return (
    <div
      className={cn(
        "rounded-md border text-xs",
        block.pending && "border-amber-500/30 bg-amber-500/[0.04]",
        !block.pending &&
          block.isError &&
          "border-destructive/40 bg-destructive/5",
        !block.pending && !block.isError && "border-border bg-muted/40",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <span
          className={cn("shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        >
          ▸
        </span>
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            block.pending
              ? "animate-pulse bg-amber-500"
              : block.isError
                ? "bg-destructive"
                : "bg-emerald-500",
          )}
          aria-hidden
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-mono font-medium text-foreground">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {summary}
        </span>
        {!block.pending && block.isError && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            failed
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-border/60 px-2.5 py-2">
          <div className="space-y-1">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
              {editPreview ? "Diff" : "Input"}
            </div>
            {editPreview ? (
              <div className="max-h-96 overflow-y-auto">
                {editPreview.kind === "write" ? (
                  <DiffView oldText="" newText={editPreview.content} />
                ) : editPreview.kind === "replace" ? (
                  <DiffView oldText={editPreview.old} newText={editPreview.next} />
                ) : (
                  <div className="space-y-1.5">
                    {editPreview.edits.map((e, i) => (
                      <DiffView key={i} oldText={e.old} newText={e.next} />
                    ))}
                  </div>
                )}
              </div>
            ) : inputObj ? (
              <div className="prose-remote max-h-56 overflow-y-auto overflow-x-auto text-[11px]">
                <Streamdown>{`\`\`\`json\n${block.input}\n\`\`\``}</Streamdown>
              </div>
            ) : (
              <pre className="max-h-56 overflow-y-auto overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                {block.input}
              </pre>
            )}
            {block.inputTruncated && (
              <div className="text-[11px] text-muted-foreground/70">
                truncated for transport
              </div>
            )}
          </div>

          {block.pending ? (
            <div className="text-[11px] italic text-muted-foreground">
              waiting for result…
            </div>
          ) : (
            <div className="space-y-1">
              <div
                className={cn(
                  "text-[10px] font-medium uppercase tracking-wide",
                  block.isError
                    ? "text-destructive"
                    : "text-muted-foreground/80",
                )}
              >
                {block.isError ? "Error" : "Result"}
              </div>
              <pre
                className={cn(
                  "max-h-72 overflow-y-auto overflow-x-auto whitespace-pre-wrap rounded font-mono text-[11px] leading-relaxed",
                  block.isError && "bg-destructive/10 px-2 py-1.5 text-destructive",
                )}
              >
                {block.output}
              </pre>
              {block.outputTruncated && (
                <div className="text-[11px] text-muted-foreground/70">
                  truncated for transport
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
