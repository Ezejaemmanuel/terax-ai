import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import type { AgentSession, AgentStatus } from "@/modules/agents/lib/types";
import { useSessionTabStore } from "@/modules/ai-history/lib/sessionTabStore";
import { copyToClipboard } from "@/modules/explorer/lib/contextActions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setTerminalsGroupByFolder } from "@/modules/settings/store";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import {
  Add01Icon,
  Cancel01Icon,
  CommandLineIcon,
  ComputerTerminal02Icon,
  Copy01Icon,
  Folder01Icon,
  FolderLibraryIcon,
  FilterIcon,
  PinIcon,
  SparklesIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  /** Open a new terminal in a folder group and launch Command Code in it. */
  onLaunchCommandCodeInFolder?: (cwd: string) => void;
  /** Open a new terminal in a folder group and launch Cursor in it. */
  onLaunchCursorInFolder?: (cwd: string) => void;
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

// Single source of truth for the per-status dot + accent so the two never drift
// apart: running=yellow, awaiting input=purple, completed=green.
const STATUS_META: Record<
  AgentStatus,
  { dot: string; border: string; title: string; pulse: boolean }
> = {
  working: { dot: "bg-yellow-400", border: "border-yellow-400/70", title: "Running", pulse: true },
  waiting: { dot: "bg-purple-500", border: "border-purple-500/70", title: "Awaiting your response", pulse: true },
  completed: { dot: "bg-emerald-500", border: "border-emerald-500/70", title: "Completed", pulse: false },
};

// Display-only ordering: a currently-running Claude session bubbles to the top
// of its scope, most-recently-active first, so the chat you just messaged sits
// up top. Pinned terminals stay above everything; idle/completed ones hold
// their place. Never mutates the persisted drag-order — only sorts what renders.
function orderByActivity(
  list: TerminalTab[],
  sessions: Record<number, AgentSession>,
): TerminalTab[] {
  const rank = (t: TerminalTab) => {
    if (t.pinned) return 0;
    return sessions[t.activeLeafId]?.status === "working" ? 1 : 2;
  };
  return list
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ra = rank(a.t);
      const rb = rank(b.t);
      if (ra !== rb) return ra - rb;
      if (ra === 1) {
        const la = sessions[a.t.activeLeafId]?.lastActivityAt ?? 0;
        const lb = sessions[b.t.activeLeafId]?.lastActivityAt ?? 0;
        if (la !== lb) return lb - la;
      }
      return a.i - b.i; // stable: preserve persisted order within a rank
    })
    .map((x) => x.t);
}

// A folder group's activity, so groups can bubble up like the terminals inside
// them: a group with a running session sorts first, then by the most-recent
// activity of any terminal in it.
function groupActivityKey(
  groupTabs: TerminalTab[],
  sessions: Record<number, AgentSession>,
): { running: boolean; recency: number } {
  let running = false;
  let recency = 0;
  for (const t of groupTabs) {
    const s = sessions[t.activeLeafId];
    if (!s) continue;
    if (s.status === "working") running = true;
    if (s.lastActivityAt > recency) recency = s.lastActivityAt;
  }
  return { running, recency };
}

// Reorder `list` to the frozen positions captured by `keyOf` (so rows/groups
// don't jump under the cursor), while keeping membership live: items missing a
// frozen position (opened since the freeze) sort after the frozen ones.
function applyFrozenOrder<T>(
  list: T[],
  frozen: Map<string | number, number>,
  keyOf: (x: T) => string | number,
): T[] {
  return list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => {
      const pa = frozen.get(keyOf(a.x));
      const pb = frozen.get(keyOf(b.x));
      if (pa != null && pb != null) return pa - pb;
      if (pa != null) return -1;
      if (pb != null) return 1;
      return a.i - b.i;
    })
    .map((e) => e.x);
}

export const TerminalListPanel = memo(function TerminalListPanel({
  tabs,
  activeId,
  onSelect,
  onClose,
  onTogglePin,
  onReorder,
  onNewInFolder,
  onLaunchClaudeInFolder,
  onLaunchCommandCodeInFolder,
  onLaunchCursorInFolder,
}: Props) {
  const agentSessions = useAgentStore(
    (s: { sessions: Record<number, AgentSession> }) => s.sessions,
  );
  const tabTitles = useSessionTabStore((s) => s.tabTitles);
  const grouped = usePreferencesStore((s) => s.terminalsGroupByFolder);

  const terminalTabs = useMemo(
    () => tabs.filter((t): t is TerminalTab => t.kind === "terminal"),
    [tabs],
  );
  const [agentFilter, setAgentFilter] = useState<"all" | "claude" | "command-code" | "cursor" | "codex">("all");
  const filteredTerminalTabs = useMemo(() => {
    if (agentFilter === "all") return terminalTabs;
    return terminalTabs.filter((t) => {
      if (agentFilter === "claude") return t.claudeSession;
      if (agentFilter === "command-code") return t.commandCodeSession;
      if (agentFilter === "cursor") return t.cursorSession;
      if (agentFilter === "codex") {
        const a = agentSessions[t.activeLeafId]?.agent?.toLowerCase() ?? "";
        return a.includes("codex");
      }
      return true;
    });
  }, [terminalTabs, agentFilter, agentSessions]);
  const canClose = filteredTerminalTabs.length > 1;

  // Recompute the activity order only when the tabs or their statuses change —
  // not on every unrelated re-render (drag indicator, title polling).
  const orderedFlat = useMemo(
    () => orderByActivity(filteredTerminalTabs, agentSessions),
    [filteredTerminalTabs, agentSessions],
  );
  const orderedGroups = useMemo(() => {
    const groups = groupByFolder(filteredTerminalTabs).map((group) => ({
      group,
      tabs: orderByActivity(group.tabs, agentSessions),
    }));
    // Bubble whole folder groups by activity too: a group with a running
    // session first, then most-recently-active, else first-seen order.
    return groups
      .map((g, i) => ({ g, i }))
      .sort((a, b) => {
        const ka = groupActivityKey(a.g.group.tabs, agentSessions);
        const kb = groupActivityKey(b.g.group.tabs, agentSessions);
        if (ka.running !== kb.running) return ka.running ? -1 : 1;
        if (ka.recency !== kb.recency) return kb.recency - ka.recency;
        return a.i - b.i;
      })
      .map((x) => x.g);
  }, [filteredTerminalTabs, agentSessions]);

  // While the pointer is over the list, freeze only the ORDER (of both groups
  // and the terminals inside them) so a row can't shift out from under the
  // cursor between hover and click. Membership still updates live: a closed
  // terminal drops out and a new one appears immediately (we always derive from
  // the current ordered lists, never a stale snapshot — snapshotting whole rows
  // made closed terminals linger in the sidebar).
  const [pointerInside, setPointerInside] = useState(false);
  const frozenPos = useRef<Map<string | number, number>>(new Map());
  const frozenGroupPos = useRef<Map<string | number, number>>(new Map());
  if (!pointerInside) {
    const tabPos = new Map<string | number, number>();
    orderedFlat.forEach((t, i) => tabPos.set(t.id, i));
    frozenPos.current = tabPos;
    const groupPos = new Map<string | number, number>();
    orderedGroups.forEach((g, i) => groupPos.set(g.group.key, i));
    frozenGroupPos.current = groupPos;
  }
  const stabilizeTabs = (list: TerminalTab[]): TerminalTab[] =>
    pointerInside ? applyFrozenOrder(list, frozenPos.current, (t) => t.id) : list;
  const displayFlat = stabilizeTabs(orderedFlat);
  const displayGroups = (
    pointerInside
      ? applyFrozenOrder(orderedGroups, frozenGroupPos.current, (g) => g.group.key)
      : orderedGroups
  ).map(({ group, tabs }) => ({ group, tabs: stabilizeTabs(tabs) }));

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
    const persistedTitle = (tab.claudeSessionId || tab.commandCodeSessionTitle) ? tab.title : undefined;
    // Command Code has no hook/title feed (unlike Claude), so a fresh launch has
    // neither a live nor a persisted title. Fall back to the tab's own agent
    // title (e.g. "cc · <folder>") or the agent name so the row never silently
    // degrades to a bare folder name and reads as a Command Code session.
    const agentFallback = tab.commandCodeSession
      ? (tab.title || "Command Code")
      : undefined;
    const sessionTitle = liveTitle ?? persistedTitle ?? agentFallback;
    const label = sessionTitle ?? cwdBasename(tab.cwd);
    const sublabel = sessionTitle ? cwdBasename(tab.cwd) : null;
    // Visible status acts as a read-receipt: once acknowledged (the terminal was
    // opened/active), it reads as no status — the dot and accent disappear until
    // the next status event un-acknowledges it.
    const status =
      agentSession && !agentSession.acknowledged ? agentSession.status : undefined;
    // Left accent follows the dot via STATUS_META; none when there's no
    // (unseen) status.
    const agentBorder = status
      ? `border-l-2 ${STATUS_META[status].border} pl-[10px]`
      : "border-l-2 border-transparent";
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
              agentBorder,
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
              // Select on pointer-down rather than click: the row is `draggable`,
              // and a native drag cancels the subsequent `click` if the pointer
              // moves even a pixel between press and release — which made
              // switching terminals require several tries. pointerdown fires
              // before drag detection begins, so a single press always switches.
              onPointerDown={() => onSelect(tab.id)}
              className="flex min-w-0 flex-1 items-start gap-2 text-left"
            >
              {agentSession ? (
                <AgentIcon
                  agent={agentSession.agent}
                  size={13}
                  className="mt-0.5 shrink-0"
                />
              ) : tab.claudeSession ? (
                <AgentIcon agent="claude" size={13} className="mt-0.5 shrink-0" />
              ) : tab.commandCodeSession ? (
                <AgentIcon agent="command-code" size={13} className="mt-0.5 shrink-0" />
              ) : tab.cursorSession ? (
                <AgentIcon agent="cursor" size={13} className="mt-0.5 shrink-0" />
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
              {status && (
                <span
                  title={STATUS_META[status].title}
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    STATUS_META[status].dot,
                    STATUS_META[status].pulse && "animate-pulse",
                  )}
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
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={agentFilter === "all" ? "Filter terminals" : `Filter: ${agentFilter === "command-code" ? "Command Code" : agentFilter.charAt(0).toUpperCase() + agentFilter.slice(1)} only`}
                className={cn(
                  "shrink-0 rounded p-0.5 transition-colors hover:bg-accent/60",
                  agentFilter !== "all" ? "text-foreground" : "text-muted-foreground/50",
                )}
              >
                <HugeiconsIcon icon={FilterIcon} size={13} strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              {(["all", "claude", "command-code", "cursor", "codex"] as const).map((opt) => (
                <DropdownMenuItem
                  key={opt}
                  onClick={() => setAgentFilter(opt)}
                  className="flex items-center gap-2 text-[12px]"
                >
                  <span className="flex w-3 items-center justify-center">
                    {agentFilter === opt && (
                      <HugeiconsIcon icon={Tick01Icon} size={11} strokeWidth={2} />
                    )}
                  </span>
                  {opt === "all" ? "All terminals" : opt === "claude" ? "Claude Code" : opt === "command-code" ? "Command Code" : opt === "cursor" ? "Cursor" : "Codex"}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        onMouseEnter={() => setPointerInside(true)}
        onMouseLeave={() => setPointerInside(false)}
      >
        {terminalTabs.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
            No terminals open.
          </p>
        ) : filteredTerminalTabs.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
            No matching terminals.
          </p>
        ) : grouped ? (
          <div className="pb-2">
            {displayGroups.map(({ group, tabs: groupTabs }) => (
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
                  (onNewInFolder || onLaunchClaudeInFolder || onLaunchCommandCodeInFolder || onLaunchCursorInFolder) ? (
                    <span className="ml-auto flex shrink-0 items-center gap-0.5">
                      {onLaunchCommandCodeInFolder && (
                        <button
                          type="button"
                          title={`Launch Command Code in ${group.label}`}
                          onClick={() => onLaunchCommandCodeInFolder(group.path!)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground group-hover/folder:opacity-100"
                        >
                          <HugeiconsIcon icon={CommandLineIcon} size={12} strokeWidth={2} />
                        </button>
                      )}
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
                      {onLaunchCursorInFolder && (
                        <button
                          type="button"
                          title={`Launch Cursor in ${group.label}`}
                          onClick={() => onLaunchCursorInFolder(group.path!)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-accent/60 hover:text-foreground group-hover/folder:opacity-100"
                        >
                          <img src="/cursor.svg" alt="" className="size-3" />
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
                {groupTabs.map((tab, i, arr) =>
                  renderTab(tab, i === arr.length - 1, group.key),
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="pb-2">
            {displayFlat.map((tab, i, arr) =>
              renderTab(tab, i === arr.length - 1, "flat"),
            )}
          </div>
        )}
      </div>
    </div>
  );
});
