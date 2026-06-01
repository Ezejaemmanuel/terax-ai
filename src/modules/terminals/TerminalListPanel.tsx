import { cn } from "@/lib/utils";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { useSessionTabStore } from "@/modules/ai-history/lib/sessionTabStore";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { ComputerTerminal02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
};

function cwdBasename(cwd?: string): string {
  if (!cwd) return "shell";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "shell";
}

export const TerminalListPanel = memo(function TerminalListPanel({
  tabs,
  activeId,
  onSelect,
}: Props) {
  const agentSessions = useAgentStore(
    (s: { sessions: Record<number, { status: string }> }) => s.sessions,
  );
  const { tabTitles } = useSessionTabStore();

  const terminalTabs = tabs.filter((t): t is TerminalTab => t.kind === "terminal");

  return (
    <div className="flex h-full flex-col border-l border-border/60 bg-card/80 backdrop-blur">
      <div className="shrink-0 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
          Terminals
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {terminalTabs.length === 0 ? (
          <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
            No terminals open.
          </p>
        ) : (
          <div className="pb-2">
            {terminalTabs.map((tab) => {
              const isActive = tab.id === activeId;
              const agentSession = agentSessions[tab.activeLeafId];
              const sessionTitle = tabTitles.get(tab.id);
              const label = sessionTitle ?? cwdBasename(tab.cwd);
              const sublabel = sessionTitle ? cwdBasename(tab.cwd) : null;
              const status = agentSession?.status as "working" | "waiting" | undefined;

              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onSelect(tab.id)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
                    isActive
                      ? "bg-accent/60 text-foreground"
                      : "text-muted-foreground hover:bg-accent/30 hover:text-foreground",
                  )}
                >
                  <HugeiconsIcon
                    icon={ComputerTerminal02Icon}
                    size={12}
                    strokeWidth={1.75}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-medium leading-tight">
                      {label}
                    </span>
                    {sublabel && (
                      <span className="block truncate text-[10px] text-muted-foreground/60">
                        {sublabel}
                      </span>
                    )}
                  </div>
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
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
