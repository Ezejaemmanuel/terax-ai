import { cn } from "@/lib/utils";
import { relativeTime } from "@/lib/relativeTime";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { writeToSession } from "@/modules/terminal";
import type { TerminalTab } from "@/modules/tabs";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import {
  ArrowRight01Icon,
  Loading03Icon,
  SearchIcon,
  SortByDown01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useMemo, useState } from "react";
import {
  type AiProject,
  type AiSession,
  useAiHistory,
} from "./lib/useAiHistory";

type Props = {
  tool: "claude" | "codex";
  newTab: (cwd?: string) => number;
  setActiveId: (id: number) => void;
  tabs: Tab[];
};

// Poll writeToSession every 150ms until the PTY is open and the write succeeds,
// then send Enter. This replaces whenSessionReady which requires OSC 7 shell
// integration (not configured by default on Windows PowerShell).
async function writeWhenReady(
  leafId: number,
  command: string,
  maxMs = 8000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (writeToSession(leafId, command)) {
      // Give the shell 120ms to echo the command before sending Enter.
      await new Promise<void>((r) => setTimeout(r, 120));
      writeToSession(leafId, "\r");
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 150));
  }
}

/** Status of Claude Code in a terminal tab */
type LiveStatus = "working" | "waiting" | null;

export const AiHistoryPanel = memo(function AiHistoryPanel({
  tool,
  newTab,
  setActiveId,
  tabs,
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

  // Memoize status for all projects.
  const projectStatuses = useMemo(
    () =>
      new Map(
        projects.map((p) => [p.fullPath, liveStatusForCwd(p.fullPath)]),
      ),
    [projects, liveStatusForCwd],
  );

  const openSession = useCallback(
    async (session: AiSession) => {
      if (opening) return;

      // If there's already a terminal tab at this CWD with Claude Code running,
      // switch to it instead of opening a new terminal.
      const { tabId: existingTabId } = liveStatusForCwd(session.cwd);
      if (existingTabId != null) {
        setActiveId(existingTabId);
        return;
      }

      // Also check for any terminal tab at the same CWD (even without Claude Code active).
      const existingTab = tabs.find(
        (t): t is TerminalTab => {
          if (t.kind !== "terminal") return false;
          const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/$/, "");
          return norm(t.cwd ?? "") === norm(session.cwd);
        },
      );
      if (existingTab) {
        setActiveId(existingTab.id);
        const leafId = existingTab.activeLeafId;
        const command =
          tool === "claude"
            ? `claude --resume ${session.id}`
            : `codex --resume ${session.id}`;
        void writeWhenReady(leafId, command);
        return;
      }

      // No existing tab — open a new one.
      setOpening(session.id);
      try {
        const cwd = session.cwd || undefined;
        const tabId = newTab(cwd);
        // Switch to the new tab immediately so TerminalPane mounts and the PTY opens.
        setActiveId(tabId);
        // useTabs.newTab always allocates tabId then leafId = tabId+1 synchronously.
        const leafId = tabId + 1;
        const command =
          tool === "claude"
            ? `claude --resume ${session.id}`
            : `codex --resume ${session.id}`;
        await writeWhenReady(leafId, command);
      } finally {
        setOpening(null);
      }
    },
    [opening, newTab, setActiveId, tabs, tool, liveStatusForCwd],
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
                  onToggleCollapse={() => toggleCollapse(project.fullPath)}
                  visibleSessions={visibleSessions(project)}
                  hiddenCount={hiddenCount(project)}
                  onShowMore={() => toggleExpand(project.fullPath)}
                  onOpenSession={openSession}
                  openingId={opening}
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
  onToggleCollapse: () => void;
  visibleSessions: AiSession[];
  hiddenCount: number;
  onShowMore: () => void;
  onOpenSession: (session: AiSession) => void;
  openingId: string | null;
};

const ProjectRow = memo(function ProjectRow({
  project,
  isCollapsed,
  liveStatus,
  onToggleCollapse,
  visibleSessions,
  hiddenCount,
  onShowMore,
  onOpenSession,
  openingId,
}: ProjectRowProps) {
  return (
    <div>
      {/* Project header */}
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left hover:bg-foreground/[0.04]"
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
        {/* Live status dot */}
        {liveStatus === "working" && (
          <span
            title="Claude Code is working"
            className="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
          />
        )}
        {liveStatus === "waiting" && (
          <span
            title="Claude Code is waiting for input"
            className="size-2 shrink-0 animate-pulse rounded-full bg-amber-400"
          />
        )}
      </button>

      {/* Sessions */}
      {!isCollapsed && (
        <div>
          {visibleSessions.map((session, i) => (
            <SessionRow
              key={session.id}
              session={session}
              isFirst={i === 0}
              isOpening={openingId === session.id}
              onOpen={() => onOpenSession(session)}
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
  isFirst: boolean;
  isOpening: boolean;
  onOpen: () => void;
};

const SessionRow = memo(function SessionRow({
  session,
  isFirst,
  isOpening,
  onOpen,
}: SessionRowProps) {
  const time = relativeTime(session.updatedAt);

  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={isOpening}
      className={cn(
        "flex w-full items-center gap-2 px-4 py-1.5 text-left transition-colors",
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
      {time && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/55">
          {time}
        </span>
      )}
    </button>
  );
});
