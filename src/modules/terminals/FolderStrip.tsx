import { cn } from "@/lib/utils";
import {
  useActiveFolderStore,
  type ActiveFolder,
} from "./activeFolderStore";
import { useSessionTabStore } from "@/modules/ai-history/lib/sessionTabStore";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  FolderOpenIcon,
  Bookmark01Icon,
  Add01Icon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useMemo, useState } from "react";
import { relativeTime } from "@/lib/relativeTime";
import {
  useAiHistory,
  type AiSession,
} from "@/modules/ai-history/lib/useAiHistory";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetActiveId: (id: number) => void;
  onOpenSession: (session: AiSession) => void;
  onNewSession: (cwd: string) => void;
};

export const FolderStrip = memo(function FolderStrip({
  tabs,
  activeId,
  onSetActiveId,
  onOpenSession,
  onNewSession,
}: Props) {
  const { folders, pinFolder, removeFolder } = useActiveFolderStore();
  const sessionTabMap = useSessionTabStore((s) => s.map);
  const [pickerFolder, setPickerFolder] = useState<ActiveFolder | null>(null);
  // Load once at FolderStrip level so FolderSessionPicker never re-fetches on each open.
  const { projects, loading: projectsLoading } = useAiHistory("claude");

  // Pre-build a cwd→tabId lookup once per render instead of scanning per folder.
  const cwdToTabId = useMemo<Map<string, number>>(() => {
    const result = new Map<string, number>();
    for (const [, tabId] of sessionTabMap) {
      const tab = tabs.find((t) => t.id === tabId && t.kind === "terminal");
      if (tab && "cwd" in tab && typeof tab.cwd === "string") {
        result.set(tab.cwd.replace(/\\/g, "/").replace(/\/$/, ""), tabId);
      }
    }
    return result;
  }, [sessionTabMap, tabs]);

  const getActiveFolderTabId = useCallback(
    (cwd: string): number | null =>
      cwdToTabId.get(cwd.replace(/\\/g, "/").replace(/\/$/, "")) ?? null,
    [cwdToTabId],
  );

  if (folders.length === 0) return null;

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-card/70 px-2 py-1 backdrop-blur">
        {folders.map((folder) => {
          const activeTabId = getActiveFolderTabId(folder.cwd);
          const isActiveTab = activeTabId === activeId;

          return (
            <div key={folder.cwd} className="group/chip relative flex items-center">
              <button
                type="button"
                onClick={() => {
                  if (activeTabId != null) {
                    onSetActiveId(activeTabId);
                  } else {
                    setPickerFolder(folder);
                  }
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  isActiveTab
                    ? "bg-foreground/[0.09] text-foreground"
                    : activeTabId != null
                      ? "bg-foreground/[0.05] text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={FolderOpenIcon}
                  size={12}
                  strokeWidth={1.75}
                  className="shrink-0"
                />
                <span className="max-w-[120px] truncate">{folder.name}</span>
                {activeTabId != null && (
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                )}
              </button>

              {/* Pin + remove controls on hover */}
              <div className="absolute -right-1 -top-1 hidden gap-0.5 group-hover/chip:flex">
                <button
                  type="button"
                  title={folder.pinned ? "Unpin folder" : "Pin folder"}
                  onClick={() => pinFolder(folder.cwd)}
                  className={cn(
                    "flex size-4 items-center justify-center rounded-sm text-[9px]",
                    folder.pinned
                      ? "bg-primary text-primary-foreground"
                      : "bg-border text-muted-foreground hover:bg-foreground/20",
                  )}
                >
                  <HugeiconsIcon icon={Bookmark01Icon} size={8} strokeWidth={2} />
                </button>
                {!folder.pinned && (
                  <button
                    type="button"
                    title="Remove"
                    onClick={() => removeFolder(folder.cwd)}
                    className="flex size-4 items-center justify-center rounded-sm bg-border text-[9px] text-muted-foreground hover:bg-foreground/20"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {pickerFolder && (
        <FolderSessionPicker
          folder={pickerFolder}
          projects={projects}
          loading={projectsLoading}
          onClose={() => setPickerFolder(null)}
          onOpenSession={(s) => {
            setPickerFolder(null);
            onOpenSession(s);
          }}
          onNewSession={(cwd) => {
            setPickerFolder(null);
            onNewSession(cwd);
          }}
        />
      )}
    </>
  );
});

// ── Session picker sheet ──────────────────────────────────────────────────────

function FolderSessionPicker({
  folder,
  projects,
  loading,
  onClose,
  onOpenSession,
  onNewSession,
}: {
  folder: ActiveFolder;
  projects: ReturnType<typeof useAiHistory>["projects"];
  loading: boolean;
  onClose: () => void;
  onOpenSession: (session: AiSession) => void;
  onNewSession: (cwd: string) => void;
}) {
  const project = projects.find(
    (p) => p.fullPath.replace(/\\/g, "/") === folder.cwd.replace(/\\/g, "/"),
  );

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="left" className="w-80 p-0">
        <SheetHeader className="border-b border-border/50 px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-[14px]">
            <HugeiconsIcon icon={FolderOpenIcon} size={14} strokeWidth={1.75} />
            {folder.name}
          </SheetTitle>
          <p className="truncate text-[11px] text-muted-foreground/70">
            {folder.cwd}
          </p>
        </SheetHeader>

        <div className="flex flex-col gap-0 p-3">
          <button
            type="button"
            onClick={() => onNewSession(folder.cwd)}
            className="mb-3 flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
            New session
          </button>

          <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
            Recent sessions
          </p>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-muted-foreground">
              <HugeiconsIcon icon={Loading03Icon} size={13} strokeWidth={1.75} className="animate-spin" />
              Loading…
            </div>
          ) : !project || project.sessions.length === 0 ? (
            <p className="px-1 py-4 text-center text-[11px] text-muted-foreground/60">
              No sessions found for this folder.
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {project.sessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onOpenSession(session)}
                  className="flex w-full flex-col rounded-md px-2 py-2 text-left transition-colors hover:bg-foreground/[0.05]"
                >
                  <span className="truncate text-[12px] font-medium text-foreground/90">
                    {session.title}
                  </span>
                  <span className="text-[10px] text-muted-foreground/60">
                    {relativeTime(session.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
