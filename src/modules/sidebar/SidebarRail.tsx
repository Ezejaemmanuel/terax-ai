import { cn } from "@/lib/utils";
import {
  ChatGptIcon,
  ClaudeIcon,
  FolderGitTwoIcon,
  FolderTreeIcon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SidebarViewId } from "./types";

export const SIDEBAR_RAIL_HEIGHT = 36;

type HugeIcon = Parameters<typeof HugeiconsIcon>[0]["icon"];

type RailItem = {
  id: SidebarViewId;
  label: string;
  /** Either a Hugeicons glyph or `{ brand }` for a bundled brand image (e.g. Cursor). */
  icon: HugeIcon | { brand: string };
  badge?: number;
};

type Props = {
  activeView: SidebarViewId;
  onSelectView: (view: SidebarViewId) => void;
  changedCount: number;
};

export function SidebarRail({ activeView, onSelectView, changedCount }: Props) {
  const items: RailItem[] = [
    { id: "explorer", label: "Files", icon: FolderTreeIcon },
    {
      id: "source-control",
      label: "Source Control",
      icon: FolderGitTwoIcon,
      badge: changedCount,
    },
    { id: "claude-history", label: "Claude", icon: ClaudeIcon },
    { id: "command-code-history", label: "Command Code", icon: SourceCodeIcon },
    { id: "cursor-history", label: "Cursor", icon: { brand: "/cursor.svg" } },
    { id: "codex-history", label: "Codex", icon: ChatGptIcon },
  ];

  return (
    <div
      style={{ height: SIDEBAR_RAIL_HEIGHT }}
      className="flex shrink-0 items-stretch gap-1 border-t border-border/60 bg-card/85 px-1.5 py-1 backdrop-blur"
    >
      {items.map((item) => {
        const isActive = item.id === activeView;
        const showBadge = !!item.badge && item.badge > 0;
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            aria-pressed={isActive}
            onClick={() => onSelectView(item.id)}
            className={cn(
              // Inactive items shrink to an icon-only square; the active item
              // grows to also show its text label.
              "group relative flex cursor-pointer items-center justify-center gap-1.5 rounded-md text-[11px] font-medium outline-none transition-[flex,background-color,color] duration-150",
              "focus-visible:ring-2 focus-visible:ring-primary/40",
              isActive ? "flex-1 px-2" : "w-8 flex-none",
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
                className="shrink-0 transition-[stroke-width] duration-150"
              />
            )}
            {isActive ? <span className="truncate">{item.label}</span> : null}
            {showBadge ? (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/60 bg-card px-1 text-[9px] font-semibold leading-none tabular-nums text-muted-foreground/95">
                {item.badge! > 99 ? "99+" : item.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
