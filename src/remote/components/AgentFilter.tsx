import {
  ChatGptIcon,
  ClaudeIcon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import type { AgentId } from "@/remote/lib/types";

type HugeIcon = Parameters<typeof HugeiconsIcon>[0]["icon"];

const AGENTS: {
  id: AgentId;
  label: string;
  icon: HugeIcon | { brand: string };
}[] = [
  { id: "claude", label: "Claude Code", icon: ClaudeIcon },
  { id: "command-code", label: "Command Code", icon: SourceCodeIcon },
  { id: "cursor", label: "Cursor", icon: { brand: "/cursor.svg" } },
  { id: "codex", label: "Codex", icon: ChatGptIcon },
];

export function AgentFilter({
  active,
  counts,
  onSelect,
}: {
  active: AgentId;
  counts: Partial<Record<AgentId, number>>;
  onSelect: (id: AgentId) => void;
}) {
  return (
    <div className="flex shrink-0 items-stretch gap-1 border-b border-border/60 px-1.5 py-1">
      {AGENTS.map((item) => {
        const isActive = item.id === active;
        const count = counts[item.id] ?? 0;
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            aria-pressed={isActive}
            onClick={() => onSelect(item.id)}
            className={cn(
              "group relative flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-[11px] font-medium outline-none transition-colors duration-150",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive
                ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            {typeof item.icon === "object" && "brand" in item.icon ? (
              <img
                src={item.icon.brand}
                alt=""
                width={14}
                height={14}
                className="shrink-0"
                style={{ width: 14, height: 14 }}
              />
            ) : (
              <HugeiconsIcon
                icon={item.icon}
                size={14}
                strokeWidth={isActive ? 2 : 1.75}
                className="shrink-0"
              />
            )}
            {count > 0 ? (
              <span
                className={cn(
                  "inline-flex h-4 min-w-4 items-center justify-center rounded-full border px-1 text-[9px] font-semibold leading-none tabular-nums",
                  isActive
                    ? "border-border bg-card text-foreground"
                    : "border-border/60 bg-card text-muted-foreground/95",
                )}
              >
                {count > 99 ? "99+" : count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
