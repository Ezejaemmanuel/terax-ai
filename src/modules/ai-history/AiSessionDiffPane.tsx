import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft01Icon,
  File01Icon,
  GitBranchIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { AiSessionDiffTab } from "@/modules/tabs/lib/useTabs";

type GitRepoInfo = { repoRoot: string; branch: string; upstream: string | null; isDetached: boolean };

type Props = {
  tab: AiSessionDiffTab;
  onClose: () => void;
  onOpenFileDiff: (input: {
    path: string;
    repoRoot: string;
    mode: "+" | "-";
    originalPath: null;
    title?: string;
  }) => void;
};


export const AiSessionDiffPane = memo(function AiSessionDiffPane({
  tab,
  onClose,
  onOpenFileDiff,
}: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [hasGit, setHasGit] = useState<boolean | null>(null);
  const [initializingGit, setInitializingGit] = useState(false);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);

  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    setFilesLoading(true);
    setFiles([]);
    setHasGit(null);
    setRepoRoot(null);
    Promise.all([
      invoke<string[]>("session_changed_files", { jsonlPath: tab.jsonlPath }),
      invoke<boolean>("session_check_git", { cwd: tab.cwd }),
      invoke<GitRepoInfo | null>("git_resolve_repo", { cwd: tab.cwd }).catch(() => null),
    ])
      .then(([changedFiles, gitOk, repoInfo]) => {
        if (cancelRef.current) return; // stale — a newer tab is now active
        setFiles(changedFiles);
        setHasGit(gitOk);
        setRepoRoot(repoInfo?.repoRoot ?? null);
        if (changedFiles.length > 0 && gitOk && repoInfo?.repoRoot) {
          onOpenFileDiff({
            path: changedFiles[0],
            repoRoot: repoInfo.repoRoot,
            mode: "+",
            originalPath: null,
            title: changedFiles[0].split(/[\\/]/).pop() ?? changedFiles[0],
          });
        }
      })
      .catch(() => { if (!cancelRef.current) setHasGit(false); })
      .finally(() => { if (!cancelRef.current) setFilesLoading(false); });
    return () => { cancelRef.current = true; };
  }, [tab.jsonlPath, tab.cwd]);

  const handleInitGit = useCallback(async () => {
    setInitializingGit(true);
    try {
      await invoke("session_git_init", { cwd: tab.cwd });
      setHasGit(true);
    } finally {
      setInitializingGit(false);
    }
  }, [tab.cwd]);

  const shortPath = tab.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/");

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border/50 bg-card/60 px-4 py-2">
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={13} strokeWidth={2} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-foreground/90">
            {tab.title}
          </p>
          <p className="truncate text-[10.5px] text-muted-foreground/60">{shortPath}</p>
        </div>
        <p className="shrink-0 text-[10.5px] text-muted-foreground/60">
          {!filesLoading && files.length > 0
            ? `${files.length} file${files.length === 1 ? "" : "s"} changed`
            : ""}
        </p>
      </div>

      {/* Body */}
      {filesLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-muted-foreground">
          <HugeiconsIcon icon={Loading03Icon} size={14} strokeWidth={1.75} className="animate-spin" />
          Loading changed files…
        </div>
      ) : hasGit === false ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <HugeiconsIcon icon={GitBranchIcon} size={36} strokeWidth={1.4} className="text-muted-foreground/30" />
          <p className="text-[12px] text-muted-foreground">No git repository found.</p>
          <button
            type="button"
            onClick={handleInitGit}
            disabled={initializingGit}
            className={cn(
              "rounded-md bg-primary px-4 py-1.5 text-[12px] font-medium text-primary-foreground",
              initializingGit && "cursor-not-allowed opacity-60",
            )}
          >
            {initializingGit ? "Initializing…" : "Initialize git repository"}
          </button>
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
          No file changes recorded for this session.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <p className="px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground/70">
            {files.length} {files.length === 1 ? "file" : "files"} changed — click to open diff
          </p>
          {files.map((fp) => {
            const name = fp.replace(/\\/g, "/").split("/").pop() ?? fp;
            const dir = fp.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
            return (
              <button
                key={fp}
                type="button"
                disabled={!repoRoot}
                onClick={() => {
                  if (repoRoot) {
                    onOpenFileDiff({
                      path: fp,
                      repoRoot,
                      mode: "+",
                      originalPath: null,
                      title: name,
                    });
                  }
                }}
                className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
              >
                <HugeiconsIcon icon={File01Icon} size={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground/60" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-foreground/90">{name}</span>
                  {dir && (
                    <span className="block truncate text-[10.5px] text-muted-foreground/55">{dir}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

