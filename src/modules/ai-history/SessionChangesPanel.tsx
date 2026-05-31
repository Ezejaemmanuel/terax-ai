import { cn } from "@/lib/utils";
import {
  ArrowLeft01Icon,
  File01Icon,
  GitBranchIcon,
  Loading03Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useState } from "react";
import type { AiSession } from "./lib/useAiHistory";
import { useSessionChanges } from "./lib/useSessionChanges";

type Props = {
  session: AiSession;
  tool: "claude" | "codex";
  onBack: () => void;
};

export const SessionChangesPanel = memo(function SessionChangesPanel({
  session,
  tool,
  onBack,
}: Props) {
  const { files, hasGit, loading, initGit, getDiff } = useSessionChanges(
    session,
    tool,
  );
  const [initializingGit, setInitializingGit] = useState(false);

  const handleInitGit = useCallback(async () => {
    setInitializingGit(true);
    try {
      await initGit();
    } finally {
      setInitializingGit(false);
    }
  }, [initGit]);

  const shortPath = session.cwd
    .replace(/\\/g, "/")
    .split("/")
    .slice(-2)
    .join("/");

  return (
    <div className="flex h-full flex-col bg-card/80 backdrop-blur [contain:layout_style]">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground"
          title="Back to history"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={12} strokeWidth={2} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] font-semibold text-foreground/90">
            {session.title}
          </p>
          <p className="truncate text-[10px] text-muted-foreground/60">
            {shortPath}
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {loading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <HugeiconsIcon
              icon={Loading03Icon}
              size={13}
              strokeWidth={1.75}
              className="animate-spin"
            />
            Loading…
          </div>
        ) : hasGit === false ? (
          <NoGitView
            onInit={handleInitGit}
            initializing={initializingGit}
          />
        ) : files.length === 0 ? (
          <div className="px-4 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            No file changes recorded for this session.
          </div>
        ) : (
          <div className="pb-2">
            <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
              {files.length} {files.length === 1 ? "file" : "files"} changed
            </div>
            {files.map((filePath) => (
              <FileRow
                key={filePath}
                filePath={filePath}
                cwd={session.cwd}
                getDiff={getDiff}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// ── NoGitView ────────────────────────────────────────────────────────────────

function NoGitView({
  onInit,
  initializing,
}: {
  onInit: () => void;
  initializing: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <HugeiconsIcon
        icon={GitBranchIcon}
        size={28}
        strokeWidth={1.4}
        className="text-muted-foreground/40"
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        This project doesn't have a git repository. Initialize one to see file
        diffs.
      </p>
      <button
        type="button"
        onClick={onInit}
        disabled={initializing}
        className={cn(
          "rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-opacity",
          initializing && "cursor-not-allowed opacity-60",
        )}
      >
        {initializing ? "Initializing…" : "Initialize git repository"}
      </button>
    </div>
  );
}

// ── FileRow ──────────────────────────────────────────────────────────────────

type FileRowProps = {
  filePath: string;
  cwd: string;
  getDiff: (filePath: string) => Promise<string>;
};

const FileRow = memo(function FileRow({ filePath, getDiff }: FileRowProps) {
  const [expanded, setExpanded] = useState(false);
  // null = not yet fetched; string = fetched (may be empty = no changes)
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const shortName = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
  const dir = filePath
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .join("/");

  const fetchDiff = useCallback(async () => {
    setLoadingDiff(true);
    setDiffError(false);
    try {
      const result = await getDiff(filePath);
      setDiff(result);
    } catch {
      // Keep diff null so the user can retry; show an error message.
      setDiffError(true);
    } finally {
      setLoadingDiff(false);
    }
  }, [getDiff, filePath]);

  const toggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    // Re-fetch on error; skip if already successfully fetched (even empty).
    if (diff !== null && !diffError) return;
    await fetchDiff();
  }, [expanded, diff, diffError, fetchDiff]);

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-foreground/[0.04]"
      >
        <HugeiconsIcon
          icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
          size={10}
          strokeWidth={2.2}
          className="shrink-0 text-muted-foreground/50"
        />
        <HugeiconsIcon
          icon={File01Icon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground/60"
        />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px] text-foreground/90">
            {shortName}
          </span>
          {dir && (
            <span className="block truncate text-[10px] text-muted-foreground/55">
              {dir}
            </span>
          )}
        </div>
        {loadingDiff && (
          <HugeiconsIcon
            icon={Loading03Icon}
            size={10}
            strokeWidth={1.75}
            className="shrink-0 animate-spin text-muted-foreground/50"
          />
        )}
      </button>

      {expanded && (
        <div className="mx-3 mb-1 overflow-x-auto rounded-md border border-border/40 bg-background/60">
          {loadingDiff ? (
            <p className="px-3 py-2 text-[10px] text-muted-foreground/60">Loading diff…</p>
          ) : diffError ? (
            <div className="flex items-center gap-2 px-3 py-2">
              <p className="text-[10px] text-destructive/80">Failed to load diff.</p>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void fetchDiff(); }}
                className="text-[10px] text-muted-foreground underline hover:text-foreground"
              >
                Retry
              </button>
            </div>
          ) : diff === null || diff.trim() === "" ? (
            <p className="px-3 py-2 text-[10px] text-muted-foreground/60">
              No unstaged changes — file may already be committed.
            </p>
          ) : (
            <DiffView diff={diff} />
          )}
        </div>
      )}
    </div>
  );
});

// ── DiffView ─────────────────────────────────────────────────────────────────

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");

  return (
    <pre className="overflow-x-auto p-2 font-mono text-[10.5px] leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith("+++") || line.startsWith("---")) {
          return (
            <span key={i} className="block text-muted-foreground/70">
              {line}
            </span>
          );
        }
        if (line.startsWith("@@")) {
          return (
            <span key={i} className="block text-blue-400/80">
              {line}
            </span>
          );
        }
        if (line.startsWith("+")) {
          return (
            <span key={i} className="block bg-emerald-500/10 text-emerald-400">
              {line}
            </span>
          );
        }
        if (line.startsWith("-")) {
          return (
            <span key={i} className="block bg-red-500/10 text-red-400">
              {line}
            </span>
          );
        }
        return (
          <span key={i} className="block text-foreground/70">
            {line}
          </span>
        );
      })}
    </pre>
  );
}
