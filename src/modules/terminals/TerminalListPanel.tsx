import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import type { AgentSession } from "@/modules/agents/lib/types";
import { useSessionTabStore } from "@/modules/ai-history/lib/sessionTabStore";
import { copyToClipboard } from "@/modules/explorer/lib/contextActions";
import type { Tab, TerminalTab } from "@/modules/tabs/lib/useTabs";
import { Cancel01Icon, ComputerTerminal02Icon, Copy01Icon } from "@hugeicons/core-free-icons";
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
                      {terminalTabs.length > 1 && (
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
            })}
          </div>
        )}
      </div>
    </div>
  );
});
