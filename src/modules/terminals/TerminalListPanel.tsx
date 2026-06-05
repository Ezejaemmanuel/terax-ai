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
  Add01Icon,
  Cancel01Icon,
  ComputerTerminal02Icon,
  Copy01Icon,
  Folder01Icon,
  FolderLibraryIcon,
  PinIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useState } from "react";
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
  /** Toggle a terminal's pinned state (shared with the tab bar). */
  onTogglePin: (id: number) => void;
  /** Move a terminal within the shared tab order. gap is an index into `tabs`. */
  onReorder: (fromId: number, toGapIndex: number) => void;
  /** Open a new terminal inside a specific folder group. */
  onNewInFolder?: (cwd: string) => void;
  /** Open a new terminal in a folder group and launch Claude in it. */
  onLaunchClaudeInFolder?: (cwd: string) => void;
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

// Where a drag would land: a line above `beforeId`, or below `afterId` (the
// last row of a scope). Kept as ids (not indices) so it survives re-renders.
type DropIndicator = { beforeId: number } | { afterId: number } | null;

export const TerminalListPanel = memo(function TerminalListPanel({
  tabs,
  activeId,
  onSelect,
  onClose,
  onTogglePin,
  onReorder,
  onNewInFolder,
  onLaunchClaudeInFolder,
}: Props) {
  const agentSessions = useAgentStore(
    (s: { sessions: Record<number, AgentSession> }) => s.sessions,
  );
  const tabTitles = useSessionTabStore((s) => s.tabTitles);
  const sessionIds = useSessionTabStore((s) => s.sessionIds);
  const grouped = usePreferencesStore((s) => s.terminalsGroupByFolder);

  const terminalTabs = tabs.filter((t): t is TerminalTab => t.kind === "terminal");
  const canClose = terminalTabs.length > 1;

  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropInd, setDropInd] = useState<DropIndicator>(null);

  const clearDrag = () => {
    setDraggingId(null);
    setDropInd(null);
  };

  // A drag may only land within the same scope: anywhere when flat, or within
  // the dragged terminal's own folder group when grouped (the user's choice).
  const sameScope = (a: TerminalTab, b: TerminalTab) =>
    !grouped || folderKey(a.cwd) === folderKey(b.cwd);

  const onRowDragOver = (e: React.DragEvent, tab: TerminalTab) => {
    if (draggingId === null || draggingId === tab.id) return;
    const dragged = terminalTabs.find((t) => t.id === draggingId);
    if (!dragged || !sameScope(dragged, tab)) {
      // Not a valid target — let the browser show "no drop" and hide the line.
      if (dropInd !== null) setDropInd(null);
      return;
    }
    e.preventDefault(); // mark as a drop target
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropInd(before ? { beforeId: tab.id } : { afterId: tab.id });
  };

  const onRowDrop = (e: React.DragEvent, tab: TerminalTab) => {
    if (draggingId === null || draggingId === tab.id) {
      clearDrag();
      return;
    }
    const dragged = terminalTabs.find((t) => t.id === draggingId);
    if (!dragged || !sameScope(dragged, tab)) {
      clearDrag();
      return;
    }
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const refIndex = tabs.findIndex((t) => t.id === tab.id);
    if (refIndex !== -1) {
      // reorderTab interprets the gap as an index into the full `tabs` array.
      onReorder(draggingId, before ? refIndex : refIndex + 1);
    }
    clearDrag();
  };

  const renderTab = (tab: TerminalTab, isLastInScope: boolean, scopeKey: string) => {
    const isActive = tab.id === activeId;
    const agentSession = agentSessions[tab.activeLeafId];
    // Live session title (freshest) → persisted Claude tab title (survives
    // restart) → folder name. The middle fallback lets a restored Claude
    // terminal show its conversation title before the hook re-links.
    const liveTitle = tabTitles.get(tab.id);
    const persistedTitle = tab.claudeSessionId ? tab.title : undefined;
    const sessionTitle = liveTitle ?? persistedTitle;
    const label = sessionTitle ?? cwdBasename(tab.cwd);
    const sublabel = sessionTitle ? cwdBasename(tab.cwd) : null;
    // Short id of the bound Claude session (first segment of the UUID) — shown
    // so a manually-launched `claude` terminal is identifiable, without dumping
    // the full ugly UUID into the title. Falls back to the persisted id so the
    // badge is present immediately after a restart, before the hook re-links.
    const boundSid = sessionIds.get(tab.id) ?? tab.claudeSessionId;
    const shortSid = boundSid?.split("-")[0];
    const status = agentSession?.status;
    const lineBefore = dropInd && "beforeId" in dropInd && dropInd.beforeId === tab.id;
    const lineAfter =
      isLastInScope && dropInd && "afterId" in dropInd && dropInd.afterId === tab.id;

    return (
      <ContextMenu key={tab.id}>
        <ContextMenuTrigger asChild>
          <div
            data-term-id={tab.id}
            data-scope={scopeKey}
            draggable
            onDragStart={(e) => {
              setDraggingId(tab.id);
              e.dataTransfer.effectAllowed = "move";
              // Firefox requires data to be set for a drag to start.
              e.dataTransfer.setData("text/plain", String(tab.id));
            }}
            onDragOver={(e) => onRowDragOver(e, tab)}
            onDrop={(e) => onRowDrop(e, tab)}
            onDragEnd={clearDrag}
            className={cn(
              "group relative flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
              agentSession
                ? "border-l-2 border-emerald-500/70 pl-[10px]"
                : "border-l-2 border-transparent",
              isActive
                ? "bg-accent/60 text-foreground"
                : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
              draggingId === tab.id && "opacity-40",
            )}
          >
            {lineBefore && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-2 -top-px h-0.5 rounded-full bg-primary"
              />
            )}
            {lineAfter && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
              />
            )}
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
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium leading-tight">
                    {label}
                  </span>
                  {shortSid && (
                    <span
                      title={`Claude session ${boundSid}`}
                      className="shrink-0 rounded bg-muted/60 px-1 font-mono text-[9px] leading-tight text-muted-foreground/70"
                    >
                      {shortSid}
                    </span>
                  )}
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
            {tab.pinned && (
              <span title="Pinned" className="mt-0.5 shrink-0 text-muted-foreground/70">
                <HugeiconsIcon icon={PinIcon} size={11} strokeWidth={1.75} />
              </span>
            )}
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
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onTogglePin(tab.id)}>
            <HugeiconsIcon icon={PinIcon} size={14} strokeWidth={1.75} />
            {tab.pinned ? "Unpin terminal" : "Pin terminal"}
          </ContextMenuItem>
          {tab.cwd && (
            <ContextMenuItem onClick={() => copyToClipboard(tab.cwd!)}>
              <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.75} />
              Copy file path
            </ContextMenuItem>
          )}
        </ContextMenuContent>
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
                  className="group/folder flex items-center gap-1.5 px-3 pb-1 pt-2.5"
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
                  {group.path &&
                  (onNewInFolder || onLaunchClaudeInFolder) ? (
                    <span className="ml-auto flex shrink-0 items-center gap-0.5">
                      {onLaunchClaudeInFolder && (
                        <button
                          type="button"
                          title={`Launch Claude in ${group.label}`}
                          onClick={() => onLaunchClaudeInFolder(group.path!)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground group-hover/folder:opacity-100"
                        >
                          <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={2} />
                        </button>
                      )}
                      {onNewInFolder && (
                        <button
                          type="button"
                          title={`New terminal in ${group.label}`}
                          onClick={() => onNewInFolder(group.path!)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground group-hover/folder:opacity-100"
                        >
                          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
                        </button>
                      )}
                    </span>
                  ) : null}
                </div>
                {group.tabs.map((tab, i) =>
                  renderTab(tab, i === group.tabs.length - 1, group.key),
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="pb-2">
            {terminalTabs.map((tab, i) =>
              renderTab(tab, i === terminalTabs.length - 1, "flat"),
            )}
          </div>
        )}
      </div>
    </div>
  );
});
