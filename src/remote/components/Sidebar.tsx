import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { AgentFilter } from "@/remote/components/AgentFilter";
import { StatusDot } from "@/remote/components/StatusDot";
import type { AgentId, AgentStatus, ProjectMeta } from "@/remote/lib/types";

/// Live rows sort to the top: on a phone the thing that is running is the whole
/// reason the page is open.
const RANK: Record<AgentStatus, number> = {
  attention: 0,
  working: 1,
  started: 1,
  finished: 2,
  exited: 4,
};

const AGENTS: AgentId[] = ["claude", "command-code", "cursor", "codex"];

export function Sidebar({
  projects,
  statuses,
  activeId,
  onSelect,
  agent,
  onAgentChange,
}: {
  projects: ProjectMeta[];
  statuses: Record<string, AgentStatus>;
  activeId: string | null;
  onSelect: (id: string) => void;
  agent: AgentId;
  onAgentChange: (id: AgentId) => void;
}) {
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const out: Partial<Record<AgentId, number>> = {};
    for (const id of AGENTS) out[id] = 0;
    for (const p of projects) {
      for (const s of p.sessions) {
        out[s.agent] = (out[s.agent] ?? 0) + 1;
      }
    }
    return out;
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .map((p) => ({
        ...p,
        sessions: p.sessions
          .filter((s) => s.agent === agent)
          .filter(
            (s) =>
              !q ||
              s.title.toLowerCase().includes(q) ||
              p.name.toLowerCase().includes(q),
          )
          .sort((a, b) => {
            const ra = RANK[statuses[a.id]] ?? 3;
            const rb = RANK[statuses[b.id]] ?? 3;
            if (ra !== rb) return ra - rb;
            return b.updatedAt.localeCompare(a.updatedAt);
          }),
      }))
      .filter((p) => p.sessions.length > 0);
  }, [projects, query, statuses, agent]);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <AgentFilter active={agent} counts={counts} onSelect={onAgentChange} />

      <div className="border-b border-border p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${agent === "claude" ? "Claude Code" : agent === "command-code" ? "Command Code" : agent} sessions`}
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {filtered.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">No sessions found.</p>
        )}
        {filtered.map((project) => (
          <section key={project.fullPath} className="py-1">
            <h2
              className="truncate px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
              title={project.fullPath}
            >
              {project.name}
            </h2>
            <ul>
              {project.sessions.map((session) => {
                const active = session.id === activeId;
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      disabled={!session.readable}
                      onClick={() => onSelect(session.id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                        active && "bg-sidebar-accent",
                        session.readable
                          ? "hover:bg-sidebar-accent/70"
                          : "cursor-not-allowed opacity-50",
                      )}
                      title={
                        session.readable
                          ? session.title
                          : "No transcript available for this session yet"
                      }
                    >
                      <StatusDot status={statuses[session.id]} />
                      <span className="min-w-0 flex-1 truncate">
                        {session.title}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
