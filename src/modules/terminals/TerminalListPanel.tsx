import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import type { AgentSession } from "@/modules/agents/lib/types";
import { useSessionTabStore } from "@/modules/ai-history/lib/sessionTabStore";
import { copyToClipboard } from "@/modules/explorer/lib/contextActions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setTerminalsGroupByFolder } from "@/modules/settings/store";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import {
  Cancel01Icon,
  ComputerTerminal02Icon,
  Copy01Icon,
  Folder01Icon,
  FolderLibraryIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
};

function cwdBasename(cwd?: string): string {
  if (!cwd) return "shell";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "shell";
}

// Stable key for the folder that opened a terminal. Normalizes slashes so the
// same directory never splits into two groups, and lower-cases on Windows-style
// paths where the filesystem is case-insensitive.
function folderKey(cwd?: string): string {
  if (!cwd) return "";
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

type FolderGroup = {
  key: string;
  /** Display name (basename) for the folder header. */
  label: string;
  /** Full path for the header tooltip; null for terminals without a cwd. */
  path: string | null;
  tabs: TerminalTab[];
};

// Bucket terminals by their opening folder, preserving first-seen order both
// for the groups and for tabs within each group.
function groupByFolder(terminalTabs: TerminalTab[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const tab of terminalTabs) {
    const key = folderKey(tab.cwd);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: key === "" ? "Other" : cwdBasename(tab.cwd),
        path: tab.cwd ?? null,
        tabs: [],
      };
      groups.set(key, group);
    }
    group.tabs.push(tab);
  }
  return [...groups.values()];
}

export const TerminalListPanel = memo(function TerminalListPanel({
  tabs,
  activeId,
  onSelect,
  onClose,
}: Props) {
  const agentSessions = useAgentStore(
    (s: { sessions: Record<number, AgentSession> }) => s.sessions,
  );
  const tabTitles = useSessionTabStore((s) => s.tabTitles);
  const grouped = usePreferencesStore((s) => s.terminalsGroupByFolder);

  const terminalTabs = tabs.filter((t): t is TerminalTab => t.kind === "terminal");
  const canClose = terminalTabs.length > 1;

  const renderTab = (tab: TerminalTab) => {
    const isActive = tab.id === activeId;
    const agentSession = agentSessions[tab.activeLeafId];
    const sessionTitle = tabTitles.get(tab.id);
    const label = sessionTitle ?? cwdBasename(tab.cwd);
    const sublabel = sessionTitle ? cwdBasename(tab.cwd) : null;
    const status = agentSession?.status;

    return (
      <ContextMenu key={tab.id}>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
              agentSession
                ? "border-l-2 border-emerald-500/70 pl-[10px]"
                : "border-l-2 border-transparent",
              isActive
                ? "bg-accent/60 text-foreground"
                : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(tab.id)}
              className="flex min-w-0 flex-1 items-start gap-2 text-left"
            >
              {agentSession ? (
                <AgentIcon
                  agent={agentSession.agent}
                  size={13}
                  className="mt-0.5 shrink-0"
                />
              ) : (
                <HugeiconsIcon
                  icon={ComputerTerminal02Icon}
                  size={12}
                  strokeWidth={1.75}
                  className="mt-0.5 shrink-0"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] font-medium leading-tight">
                  {label}
                </span>
                {sublabel && (
                  <span className="block truncate text-[10px] text-muted-foreground/60">
                    {sublabel}
                  </span>
                )}
              </span>
              {status === "working" && (
                <span
                  title="Working"
                  className="mt-1 size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                />
              )}
              {status === "waiting" && (
                <span
                  title="Waiting for input"
                  className="mt-1 size-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"
                />
              )}
              {status === "completed" && (
                <span
                  title="Idle"
                  className="mt-1 size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                />
              )}
            </button>
            {canClose && (
              <button
                type="button"
                aria-label="Close terminal"
                onClick={() => onClose(tab.id)}
                className="mt-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-60"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        {tab.cwd && (
          <ContextMenuContent>
            <ContextMenuItem onClick={() => copyToClipboard(tab.cwd!)}>
              <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.75} />
              Copy file path
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
    );
  };

  return (
    <div className="flex h-full flex-col border-l border-border/60 bg-card/80 backdrop-blur">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
          Terminals
        </span>
        <button
          type="button"
          onClick={() => void setTerminalsGroupByFolder(!grouped)}
          title={grouped ? "Grouping by folder" : "Group by folder"}
          aria-pressed={grouped}
          className={cn(
            "shrink-0 rounded p-0.5 transition-colors hover:bg-accent/60",
            grouped
              ? "text-foreground"
              : "text-muted-foreground/50 hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={FolderLibraryIcon} size={13} strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {terminalTabs.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
            No terminals open.
          </p>
        ) : grouped ? (
          <div className="pb-2">
            {groupByFolder(terminalTabs).map((group) => (
              <div key={group.key}>
                <div
                  className="flex items-center gap-1.5 px-3 pb-1 pt-2.5"
                  title={group.path ?? undefined}
                >
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    size={11}
                    strokeWidth={1.75}
                    className="shrink-0 text-muted-foreground/50"
                  />
                  <span className="truncate text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/55">
                    {group.label}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/40">
                    {group.tabs.length}
                  </span>
                </div>
                {group.tabs.map(renderTab)}
              </div>
            ))}
          </div>
        ) : (
          <div className="pb-2">{terminalTabs.map(renderTab)}</div>
        )}
      </div>
    </div>
  );
});
