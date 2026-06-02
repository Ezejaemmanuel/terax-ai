import { cn } from "@/lib/utils";
import { useActiveFolderStore } from "./activeFolderStore";
import type { SidebarViewId } from "@/modules/sidebar";
import { FolderOpenIcon, Bookmark01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useMemo } from "react";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  sidebarView: SidebarViewId;
  onSetActiveId: (id: number) => void;
  onSwitchToFolder: (cwd: string) => void;
};

function normCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/$/, "");
}

export const FolderStrip = memo(function FolderStrip({
  tabs,
  activeId,
  sidebarView,
  onSetActiveId,
  onSwitchToFolder,
}: Props) {
  const { folders, pinFolder, removeFolder } = useActiveFolderStore();

  // cwd → first terminal tab at that cwd. Scans all terminal tabs (not just
  // mapped chat sessions) so select-or-create dedupes plain terminals too.
  const cwdToTabId = useMemo<Map<string, number>>(() => {
    const result = new Map<string, number>();
    for (const tab of tabs) {
      if (tab.kind !== "terminal" || typeof tab.cwd !== "string") continue;
      const key = normCwd(tab.cwd);
      if (!result.has(key)) result.set(key, tab.id);
    }
    return result;
  }, [tabs]);

  const getFolderTabId = useCallback(
    (cwd: string): number | null => cwdToTabId.get(normCwd(cwd)) ?? null,
    [cwdToTabId],
  );

  // In the AI history views the strip is informational only — clicking a chip
  // must not yank the workspace to another folder.
  const canSwitch =
    sidebarView === "explorer" || sidebarView === "source-control";

  if (folders.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/50 bg-card/70 px-2 py-1 backdrop-blur">
      {folders.map((folder) => {
        const folderTabId = getFolderTabId(folder.cwd);
        const isActiveTab = folderTabId === activeId;

        return (
          <div key={folder.cwd} className="group/chip relative flex items-center">
            <button
              type="button"
              disabled={folderTabId == null && !canSwitch}
              onClick={() => {
                if (folderTabId != null) {
                  onSetActiveId(folderTabId);
                } else if (canSwitch) {
                  onSwitchToFolder(folder.cwd);
                }
              }}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                isActiveTab
                  ? "bg-foreground/[0.09] text-foreground"
                  : folderTabId != null
                    ? "bg-foreground/[0.05] text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground"
                    : canSwitch
                      ? "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                      : "text-muted-foreground/50 cursor-default",
              )}
            >
              <HugeiconsIcon
                icon={FolderOpenIcon}
                size={12}
                strokeWidth={1.75}
                className="shrink-0"
              />
              <span className="max-w-[120px] truncate">{folder.name}</span>
              {folderTabId != null && (
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
  );
});
