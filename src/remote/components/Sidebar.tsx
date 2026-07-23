import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/remote/components/StatusDot";
import type { AgentStatus, ProjectMeta } from "@/remote/lib/types";

const AGENT_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  "command-code": "Command",
  cursor: "Cursor",
};

/// Live rows sort to the top: on a phone the thing that is running is the whole
/// reason the page is open.
const RANK: Record<AgentStatus, number> = {
  attention: 0,
  working: 1,
  started: 1,
  finished: 2,
  exited: 4,
};

export function Sidebar({
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
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .map((p) => ({
        ...p,
        sessions: p.sessions
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
  }, [projects, query, statuses]);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="border-b border-border p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions"
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
                          : "Cursor stores transcripts in SQLite, not readable here"
                      }
                    >
                      <StatusDot status={statuses[session.id]} />
                      <span className="min-w-0 flex-1 truncate">
                        {session.title}
                      </span>
                      <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
                        {AGENT_LABEL[session.agent] ?? session.agent}
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
