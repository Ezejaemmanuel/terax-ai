import { useMemo, useState } from "react";
import {
  FilterIcon,
  Folder01Icon,
  FolderLibraryIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentId, AgentStatus, ProjectMeta, SessionMeta } from "@/remote/lib/types";

type AgentFilterOpt = "all" | AgentId;

const FILTER_LABEL: Record<AgentFilterOpt, string> = {
  all: "All terminals",
  claude: "Claude Code",
  "command-code": "Command Code",
  cursor: "Cursor",
  codex: "Codex",
};

/// Desktop terminal-list dots: running=yellow, awaiting=purple, done=green.
const STATUS_META: Partial<
  Record<AgentStatus, { dot: string; border: string; title: string; pulse: boolean }>
> = {
  started: {
    dot: "bg-yellow-400",
    border: "border-yellow-400/70",
    title: "Starting",
    pulse: true,
  },
  working: {
    dot: "bg-yellow-400",
    border: "border-yellow-400/70",
    title: "Running",
    pulse: true,
  },
  attention: {
    dot: "bg-purple-500",
    border: "border-purple-500/70",
    title: "Awaiting your response",
    pulse: true,
  },
  finished: {
    dot: "bg-emerald-500",
    border: "border-emerald-500/70",
    title: "Completed",
    pulse: false,
  },
};

function cwdBasename(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function folderKey(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

type Row = {
  session: SessionMeta;
  projectName: string;
  projectPath: string;
};

function rank(status: AgentStatus | undefined): number {
  if (!status) return 3;
  if (status === "attention") return 0;
  if (status === "working" || status === "started") return 1;
  if (status === "finished") return 2;
  return 4;
}

export function TerminalPanel({
  projects,
  statuses,
  activeId,
  onSelect,
}: {
  projects: ProjectMeta[];
  statuses: Record<string, AgentStatus>;
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const [agentFilter, setAgentFilter] = useState<AgentFilterOpt>("all");
  const [grouped, setGrouped] = useState(true);

  const rows = useMemo(() => {
    const all: Row[] = [];
    for (const project of projects) {
      for (const session of project.sessions) {
        if (!session.readable) continue;
        if (agentFilter !== "all" && session.agent !== agentFilter) continue;
        // `statuses` only carries an entry while its pty is alive (see
        // useStream), so this is "currently open", not "ever seen" — the
        // session index below is built from history files on disk and would
        // otherwise list every terminal that has ever run.
        if (!(session.id in statuses)) continue;
        all.push({
          session,
          projectName: project.name,
          projectPath: project.fullPath,
        });
      }
    }
    all.sort((a, b) => {
      const ra = rank(statuses[a.session.id]);
      const rb = rank(statuses[b.session.id]);
      if (ra !== rb) return ra - rb;
      return b.session.updatedAt.localeCompare(a.session.updatedAt);
    });
    return all;
  }, [projects, statuses, agentFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, { label: string; path: string; rows: Row[] }>();
    for (const row of rows) {
      const key = folderKey(row.session.cwd || row.projectPath);
      let group = map.get(key);
      if (!group) {
        group = {
          label: key ? cwdBasename(row.session.cwd || row.projectName) : "Other",
          path: row.session.cwd || row.projectPath,
          rows: [],
        };
        map.set(key, group);
      }
      group.rows.push(row);
    }
    return [...map.values()];
  }, [rows]);

  const renderRow = (session: SessionMeta) => {
    const active = session.id === activeId;
    const status = statuses[session.id];
    const meta = status ? STATUS_META[status] : undefined;
    const label = session.title;
    const sublabel = cwdBasename(session.cwd);

    return (
      <button
        key={session.id}
        type="button"
        onClick={() => onSelect(session.id)}
        className={cn(
          "group relative flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
          meta ? `border-l-2 ${meta.border} pl-[10px]` : "border-l-2 border-transparent",
          active
            ? "bg-accent/60 text-foreground"
            : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
        )}
      >
        <AgentIcon
          agent={session.agent}
          size={13}
          className="mt-0.5 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11.5px] font-medium leading-tight text-foreground">
            {label}
          </span>
          <span className="block truncate text-[10px] text-muted-foreground/60">
            {sublabel}
          </span>
        </span>
        {meta && (
          <span
            title={meta.title}
            className={cn(
              "mt-1 size-1.5 shrink-0 rounded-full",
              meta.dot,
              meta.pulse && "animate-pulse",
            )}
          />
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col bg-card/80">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
          Terminals
        </span>
        <div className="flex items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={
                  agentFilter === "all"
                    ? "Filter terminals"
                    : `Filter: ${FILTER_LABEL[agentFilter]} only`
                }
                className={cn(
                  "shrink-0 rounded p-0.5 transition-colors hover:bg-accent/60",
                  agentFilter !== "all"
                    ? "text-foreground"
                    : "text-muted-foreground/50",
                )}
              >
                <HugeiconsIcon icon={FilterIcon} size={13} strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              {(
                ["all", "claude", "command-code", "cursor", "codex"] as const
              ).map((opt) => (
                <DropdownMenuItem
                  key={opt}
                  onClick={() => setAgentFilter(opt)}
                  className="flex items-center gap-2 text-[12px]"
                >
                  <span className="flex w-3 items-center justify-center">
                    {agentFilter === opt && (
                      <HugeiconsIcon
                        icon={Tick01Icon}
                        size={11}
                        strokeWidth={2}
                      />
                    )}
                  </span>
                  {FILTER_LABEL[opt]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => setGrouped((v) => !v)}
            title={grouped ? "Grouping by folder" : "Group by folder"}
            aria-pressed={grouped}
            className={cn(
              "shrink-0 rounded p-0.5 transition-colors hover:bg-accent/60",
              grouped
                ? "text-foreground"
                : "text-muted-foreground/50 hover:text-foreground",
            )}
          >
            <HugeiconsIcon
              icon={FolderLibraryIcon}
              size={13}
              strokeWidth={1.75}
            />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        {rows.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
            {agentFilter === "all"
              ? "No terminals open right now."
              : "No matching terminals open right now."}
          </p>
        ) : grouped ? (
          <div className="pb-2">
            {groups.map((group) => (
              <div key={group.path}>
                <div
                  className="flex items-center gap-1.5 px-3 pb-1 pt-2.5"
                  title={group.path}
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
                    {group.rows.length}
                  </span>
                </div>
                {group.rows.map(({ session }) => renderRow(session))}
              </div>
            ))}
          </div>
        ) : (
          <div className="pb-2">{rows.map(({ session }) => renderRow(session))}</div>
        )}
      </div>
    </div>
  );
}
