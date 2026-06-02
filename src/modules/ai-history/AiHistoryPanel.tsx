import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/relativeTime";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { writeToSession } from "@/modules/terminal";
import type { TerminalTab } from "@/modules/tabs";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import {
  Add01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  FileEditIcon,
  Loading03Icon,
  SearchIcon,
  SortByDown01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  type AiProject,
  type AiSession,
  useAiHistory,
} from "./lib/useAiHistory";
import { useSessionTabStore } from "./lib/sessionTabStore";
import { useActiveFolderStore } from "@/modules/terminals/activeFolderStore";
import { agentStatusStyle } from "@/modules/agents/lib/statusLabel";
import type { AgentStatus } from "@/modules/agents/lib/types";

type Props = {
  tool: "claude" | "codex";
  newTab: (cwd?: string) => number;
  setActiveId: (id: number) => void;
  tabs: Tab[];
  onViewChanges?: (session: AiSession) => void;
};

// Poll writeToSession every 150ms until the PTY is open and the write succeeds,
// then send Enter. This replaces whenSessionReady which requires OSC 7 shell
// integration (not configured by default on Windows PowerShell).
// Returns true if the command was successfully written, false on timeout.
async function writeWhenReady(
  leafId: number,
  command: string,
  maxMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (writeToSession(leafId, command)) {
      // Give the shell 120ms to echo the command before sending Enter.
      await new Promise<void>((r) => setTimeout(r, 120));
      writeToSession(leafId, "\r");
      return true;
    }
    await new Promise<void>((r) => setTimeout(r, 150));
  }
  return false;
}

/** Status of Claude Code in a terminal tab (null = no live session) */
type LiveStatus = AgentStatus | null;

export const AiHistoryPanel = memo(function AiHistoryPanel({
  tool,
  newTab,
  setActiveId,
  tabs,
  onViewChanges,
}: Props) {
  const {
    projects,
    loading,
    error,
    search,
    setSearch,
    collapsed,
    toggleCollapse,
    toggleExpand,
    visibleSessions,
    hiddenCount,
  } = useAiHistory(tool);

  const [opening, setOpening] = useState<string | null>(null);
  const [openingNewCwd, setOpeningNewCwd] = useState<string | null>(null);

  // Module-level store survives sidebar panel switches (component unmounts).
  const { getTabId, setMapping, clearStaleTabIds } = useSessionTabStore();
  const addFolder = useActiveFolderStore((s) => s.addFolder);
  // Reactive subscription so the effect re-runs if mappings change independently.
  const storeMap = useSessionTabStore((s) => s.map);

  // Single batched call — one Map copy, one subscriber notification per tabs change.
  useEffect(() => {
    const activeTabIds = new Set(tabs.map((t) => t.id));
    clearStaleTabIds(activeTabIds);
  }, [tabs, storeMap, clearStaleTabIds]);

  // Agent sessions from the store — keyed by leafId.
  const agentSessions = useAgentStore((s: { sessions: Record<number, import("@/modules/agents/lib/types").AgentSession> }) => s.sessions);

  // For a given project CWD, find whether any terminal tab at that path has
  // an active Claude Code session, and what its current status is.
  const liveStatusForCwd = useCallback(
    (cwd: string): { status: LiveStatus; tabId: number | null } => {
      const terminalTabs = tabs.filter(
        (t): t is TerminalTab => t.kind === "terminal",
      );
      for (const tab of terminalTabs) {
        // Check all leaf IDs in this tab's pane tree
        const leafId = tab.activeLeafId;
        const tabCwd = tab.cwd ?? "";
        const normalizedTabCwd = tabCwd.replace(/\\/g, "/").replace(/\/$/, "");
        const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
        if (normalizedTabCwd === normalizedCwd) {
          const session = agentSessions[leafId];
          if (session) {
            return { status: session.status as LiveStatus, tabId: tab.id };
          }
        }
      }
      return { status: null, tabId: null };
    },
    [tabs, agentSessions],
  );

  const openNewSession = useCallback(
    async (cwd: string) => {
      if (openingNewCwd) return;

      // If there's already a terminal tab at this CWD with the tool running,
      // just switch to it rather than spawning a duplicate.
      const { tabId: existingTabId } = liveStatusForCwd(cwd);
      if (existingTabId != null) {
        setActiveId(existingTabId);
        return;
      }

      setOpeningNewCwd(cwd);
      try {
        const tabId = newTab(cwd);
        setActiveId(tabId);
        const leafId = tabId + 1;
        const command = tool === "claude" ? "claude --permission-mode auto" : "codex";
        await writeWhenReady(leafId, command);
        addFolder(cwd, projects.find((p) => p.fullPath === cwd)?.name ?? cwd.split(/[\\/]/).pop() ?? cwd);
      } finally {
        setOpeningNewCwd(null);
      }
    },
    [openingNewCwd, newTab, setActiveId, tool, liveStatusForCwd, addFolder, projects],
  );

  // Memoize status for all projects.
  const projectStatuses = useMemo(
    () =>
      new Map(
        projects.map((p) => [p.fullPath, liveStatusForCwd(p.fullPath)]),
      ),
    [projects, liveStatusForCwd],
  );

  // Per-session live status, keyed by sessionId. Only sessions we opened/resumed
  // have a tab mapping; we follow sessionId → tabId → activeLeafId → status.
  const sessionStatuses = useMemo(() => {
    const m = new Map<string, AgentStatus>();
    for (const [sessionId, tabId] of storeMap) {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab && tab.kind === "terminal") {
        const session = agentSessions[(tab as TerminalTab).activeLeafId];
        if (session) m.set(sessionId, session.status);
      }
    }
    return m;
  }, [storeMap, tabs, agentSessions]);

  const openSession = useCallback(
    async (session: AiSession) => {
      if (opening) return;

      // If we already opened a tab for this specific session, switch to it.
      const mappedTabId = getTabId(session.id);
      if (mappedTabId != null && tabs.some((t) => t.id === mappedTabId)) {
        setActiveId(mappedTabId);
        return;
      }

      // No existing tab — open a new one and resume it.
      setOpening(session.id);
      try {
        const cwd = session.cwd || undefined;
        const tabId = newTab(cwd);
        setActiveId(tabId);
        const leafId = tabId + 1;
        const command =
          tool === "claude"
            ? `claude --resume ${session.id}`
            : `codex --resume ${session.id}`;
        const sent = await writeWhenReady(leafId, command);
        // Only record the mapping if the command was actually delivered.
        // A timeout leaves the tab open (user can retry manually) but we don't
        // lock the session to a tab that has no Claude process.
        if (sent) {
          setMapping(session.id, tabId, session.title);
          addFolder(session.cwd, projects.find((p) => p.fullPath === session.cwd)?.name ?? session.cwd.split(/[\\/]/).pop() ?? session.cwd);
        }
      } finally {
        setOpening(null);
      }
    },
    [opening, newTab, setActiveId, tabs, tool, getTabId, setMapping, addFolder, projects],
  );

  const label = tool === "claude" ? "Claude Code" : "Codex";

  return (
    <div className="flex h-full flex-col bg-card/80 backdrop-blur [contain:layout_style]">
      {/* Search bar */}
      <div className="shrink-0 border-b border-border/50 px-2 py-2">
        <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background/70 px-2.5 py-1.5 focus-within:border-primary/40">
          <HugeiconsIcon
            icon={SearchIcon}
            size={12}
            strokeWidth={1.9}
            className="shrink-0 text-muted-foreground/70"
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${label} history…`}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/50"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="shrink-0 text-[10px] text-muted-foreground/60 hover:text-foreground"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Section header */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
          Projects
        </span>
        <button
          type="button"
          className="ml-auto text-muted-foreground/60 hover:text-foreground"
          aria-label="Sort"
        >
          <HugeiconsIcon icon={SortByDown01Icon} size={12} strokeWidth={1.8} />
        </button>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <HugeiconsIcon
              icon={Loading03Icon}
              size={14}
              strokeWidth={1.75}
              className="animate-spin"
            />
            Loading…
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-[11px] text-destructive">{error}</div>
        ) : projects.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            {search
              ? "No sessions match your search."
              : `No ${label} sessions found.`}
          </div>
        ) : (
          <div className="pb-2">
            {projects.map((project) => {
              const liveInfo = projectStatuses.get(project.fullPath) ?? {
                status: null,
                tabId: null,
              };
              return (
                <ProjectRow
                  key={project.fullPath}
                  project={project}
                  isCollapsed={collapsed.has(project.fullPath)}
                  liveStatus={liveInfo.status}
                  sessionStatuses={sessionStatuses}
                  onToggleCollapse={() => toggleCollapse(project.fullPath)}
                  visibleSessions={visibleSessions(project)}
                  hiddenCount={hiddenCount(project)}
                  onShowMore={() => toggleExpand(project.fullPath)}
                  onOpenSession={openSession}
                  openingId={opening}
                  onNewSession={() => openNewSession(project.fullPath)}
                  isOpeningNew={openingNewCwd === project.fullPath}
                  onCopySessionId={(id) => navigator.clipboard.writeText(id)}
                  onViewChanges={(session) => {
                    if (onViewChanges) onViewChanges(session);
                    else console.warn("AiHistoryPanel: onViewChanges prop not provided");
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

type ProjectRowProps = {
  project: AiProject;
  isCollapsed: boolean;
  liveStatus: LiveStatus;
  sessionStatuses: Map<string, AgentStatus>;
  onToggleCollapse: () => void;
  visibleSessions: AiSession[];
  hiddenCount: number;
  onShowMore: () => void;
  onOpenSession: (session: AiSession) => void;
  openingId: string | null;
  onNewSession: () => void;
  isOpeningNew: boolean;
  onCopySessionId: (sessionId: string) => void;
  onViewChanges: (session: AiSession) => void;
};

const ProjectRow = memo(function ProjectRow({
  project,
  isCollapsed,
  liveStatus,
  sessionStatuses,
  onToggleCollapse,
  visibleSessions,
  hiddenCount,
  onShowMore,
  onOpenSession,
  openingId,
  onNewSession,
  isOpeningNew,
  onCopySessionId,
  onViewChanges,
}: ProjectRowProps) {
  return (
    <div>
      {/* Project header */}
      <div className="group/project-row flex items-center hover:bg-foreground/[0.04]">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left"
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={10}
            strokeWidth={2.2}
            className={cn(
              "shrink-0 text-muted-foreground/60 transition-transform duration-100",
              !isCollapsed && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground/90">
            {project.name}
          </span>
          {/* Live status — dot + text label */}
          {liveStatus && <StatusLabel status={liveStatus} />}
        </button>
        {/* New session button — visible on row hover */}
        <button
          type="button"
          disabled={isOpeningNew}
          onClick={onNewSession}
          title="Start new session in auto mode"
          className={cn(
            "mr-1.5 flex shrink-0 items-center justify-center rounded p-0.5",
            "opacity-0 transition-opacity duration-100 group-hover/project-row:opacity-100",
            "text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground",
            isOpeningNew && "cursor-not-allowed opacity-60",
          )}
        >
          {isOpeningNew ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              size={12}
              strokeWidth={1.75}
              className="animate-spin"
            />
          ) : (
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
          )}
        </button>
      </div>

      {/* Sessions */}
      {!isCollapsed && (
        <div>
          {visibleSessions.map((session, i) => (
            <SessionRow
              key={session.id}
              session={session}
              liveStatus={sessionStatuses.get(session.id) ?? null}
              isFirst={i === 0}
              isOpening={openingId === session.id}
              onOpen={() => onOpenSession(session)}
              onCopyId={() => onCopySessionId(session.id)}
              onViewChanges={() => onViewChanges(session)}
            />
          ))}

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={onShowMore}
              className="w-full px-6 py-1 text-left text-[11px] text-muted-foreground/60 hover:text-foreground"
            >
              Show {hiddenCount} more
            </button>
          )}
        </div>
      )}
    </div>
  );
});

type SessionRowProps = {
  session: AiSession;
  liveStatus: LiveStatus;
  isFirst: boolean;
  isOpening: boolean;
  onOpen: () => void;
  onCopyId: () => void;
  onViewChanges: () => void;
};

const SessionRow = memo(function SessionRow({
  session,
  liveStatus,
  isFirst,
  isOpening,
  onOpen,
  onCopyId,
  onViewChanges,
}: SessionRowProps) {
  const time = relativeTime(session.updatedAt);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group/session-row relative">
          <button
            type="button"
            onClick={onOpen}
            disabled={isOpening}
            className={cn(
              "flex w-full items-center gap-2 px-4 py-1.5 pr-8 text-left transition-colors",
              isFirst
                ? "text-foreground hover:bg-accent/40"
                : "text-muted-foreground hover:bg-accent/25 hover:text-foreground",
              isOpening && "opacity-60",
            )}
          >
            {isOpening && (
              <HugeiconsIcon
                icon={Loading03Icon}
                size={10}
                strokeWidth={1.75}
                className="shrink-0 animate-spin text-muted-foreground"
              />
            )}
            <span className="min-w-0 flex-1 truncate text-[11.5px]">
              {session.title}
            </span>
            {liveStatus ? (
              <StatusLabel status={liveStatus} />
            ) : (
              time && (
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/55">
                  {time}
                </span>
              )
            )}
          </button>
          {/* View changes button — appears on row hover */}
          <button
            type="button"
            onClick={onViewChanges}
            title="View changed files"
            className={cn(
              "absolute right-1.5 top-1/2 -translate-y-1/2",
              "flex items-center justify-center rounded p-0.5",
              "opacity-0 transition-opacity duration-100 group-hover/session-row:opacity-100",
              "text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground",
            )}
          >
            <HugeiconsIcon icon={FileEditIcon} size={11} strokeWidth={1.75} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onViewChanges}>
          <HugeiconsIcon icon={FileEditIcon} size={14} strokeWidth={1.75} />
          View changes
        </ContextMenuItem>
        <ContextMenuItem onClick={onCopyId}>
          <HugeiconsIcon icon={Copy01Icon} size={14} strokeWidth={1.75} />
          Copy chat ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** Dot + text label for a live agent status, shared by project and session rows. */
function StatusLabel({ status }: { status: AgentStatus }) {
  const s = agentStatusStyle(status);
  return (
    <span className="flex shrink-0 items-center gap-1" title={`Claude Code: ${s.text}`}>
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 rounded-full", s.dot, s.pulse && "animate-pulse")}
      />
      <span className={cn("text-[10px] font-medium", s.textColor)}>{s.text}</span>
    </span>
  );
}
