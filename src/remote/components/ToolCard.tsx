import { useEffect, useState } from "react";
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
import type { ToolRowBlock } from "@/remote/lib/mergeTranscript";

type HugeIcon = Parameters<typeof HugeiconsIcon>[0]["icon"];

/// Native Claude Code tool names. Unknown / MCP tools fall back to a generic
/// wrench icon with their raw name as the label.
const TOOL_META: Record<string, { label: string; icon: HugeIcon }> = {
  Read: { label: "Read", icon: File01Icon },
  Write: { label: "Write", icon: FilePlusIcon },
  Edit: { label: "Edit", icon: FileEditIcon },
  MultiEdit: { label: "Edit", icon: Edit02Icon },
  NotebookEdit: { label: "Notebook", icon: FileEditIcon },
  Bash: { label: "Run", icon: TerminalIcon },
  BashOutput: { label: "Logs", icon: TerminalIcon },
  KillShell: { label: "Kill", icon: TerminalIcon },
  Grep: { label: "Search", icon: GlobalSearchIcon },
  Glob: { label: "Glob", icon: Folder01Icon },
  LS: { label: "List", icon: FolderOpenIcon },
  WebFetch: { label: "Fetch", icon: GlobalSearchIcon },
  WebSearch: { label: "Search", icon: GlobalSearchIcon },
  Task: { label: "Subagent", icon: RobotIcon },
  TodoWrite: { label: "Todos", icon: CheckListIcon },
  ExitPlanMode: { label: "Plan", icon: SparklesIcon },
};

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

function firstLine(s: string, max = 56) {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function deriveSummary(name: string, inputText: string): string {
  const obj = parseInput(inputText);
  if (!obj) return firstLine(inputText);
  const str = (k: string) =>
    typeof obj[k] === "string" ? (obj[k] as string) : null;

  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return str("file_path") ?? firstLine(inputText);
    case "NotebookEdit":
      return str("notebook_path") ?? firstLine(inputText);
    case "Bash":
      return str("command") ?? firstLine(inputText);
    case "BashOutput":
    case "KillShell":
      return str("bash_id") ?? firstLine(inputText);
    case "Grep":
    case "Glob":
      return str("pattern") ?? firstLine(inputText);
    case "LS":
      return str("path") ?? firstLine(inputText);
    case "WebFetch":
      return str("url") ?? firstLine(inputText);
    case "WebSearch":
      return str("query") ?? firstLine(inputText);
    case "Task":
      return str("description") ?? str("subagent_type") ?? firstLine(inputText);
    case "TodoWrite": {
      const todos = Array.isArray(obj.todos) ? obj.todos : null;
      return todos
        ? `${todos.length} item${todos.length === 1 ? "" : "s"}`
        : firstLine(inputText);
    }
    default:
      return firstLine(inputText);
  }
}

export function ToolCard({
  block,
  defaultOpen,
}: {
  block: ToolRowBlock;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  const meta = TOOL_META[block.name];
  const Icon = meta?.icon ?? ToolsIcon;
  const label = meta?.label ?? block.name;
  const summary = deriveSummary(block.name, block.input);
  const inputObj = parseInput(block.input);

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
              Input
            </div>
            {inputObj ? (
              <div className="prose-remote overflow-x-auto text-[11px]">
                <Streamdown>{`\`\`\`json\n${block.input}\n\`\`\``}</Streamdown>
              </div>
            ) : (
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
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
                  "overflow-x-auto whitespace-pre-wrap rounded font-mono text-[11px] leading-relaxed",
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
}
