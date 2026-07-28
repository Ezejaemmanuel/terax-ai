import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { COMPACT_CONTENT, COMPACT_ITEM } from "@/modules/explorer/lib/menuItemClass";
import { cn } from "@/lib/utils";
import { normalizeRoot, useLspStore } from "./store";

type Props = {
  /** Project folder the toggle governs. */
  root: string;
};

const DOT_BY_STATE: Record<string, string> = {
  starting: "bg-amber-400",
  ready: "bg-emerald-500",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/50",
};

/**
 * The per-project TypeScript switch, sitting between folder chips. Left click
 * turns the server on for this session only; the menu is where a project asks
 * to be remembered across restarts.
 */
export function LspToggle({ root }: Props) {
  const key = normalizeRoot(root);
  const mode = useLspStore((s) => s.enabled[key] ?? "off");
  const status = useLspStore((s) => s.status[key]);
  const checking = useLspStore((s) => s.checking[key] ?? false);
  const enable = useLspStore((s) => s.enable);
  const disable = useLspStore((s) => s.disable);
  const checkProject = useLspStore((s) => s.checkProject);

  const on = mode !== "off";
  const state = on ? (status?.state ?? "starting") : "stopped";
  const title = on
    ? state === "failed"
      ? `TypeScript: ${status?.error ?? "failed to start"}`
      : `TypeScript ${state}${mode === "persistent" ? " (remembered)" : " (this session)"}`
    : "TypeScript off. Click to enable for this session, right-click for more.";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={title}
          onClick={() => {
            if (on) void disable(key);
            else void enable(key, "session");
          }}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[9px] font-semibold tracking-wide transition-colors",
            on
              ? "bg-foreground/[0.08] text-foreground/80 hover:bg-foreground/[0.12]"
              : "text-muted-foreground/40 hover:bg-foreground/[0.05] hover:text-muted-foreground",
          )}
        >
          <span>TS</span>
          {on && (
            <span
              className={cn(
                "size-1 rounded-full",
                DOT_BY_STATE[state] ?? DOT_BY_STATE.stopped,
              )}
            />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className={COMPACT_CONTENT}>
        <ContextMenuItem
          className={COMPACT_ITEM}
          disabled={mode === "session"}
          onClick={() => void enable(key, "session")}
        >
          Enable for this session
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_ITEM}
          disabled={mode === "persistent"}
          onClick={() => void enable(key, "persistent")}
        >
          Enable and remember
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_ITEM}
          disabled={!on}
          onClick={() => void disable(key)}
        >
          Disable
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          disabled={!on || checking}
          onClick={() => void checkProject(key)}
        >
          {checking ? "Checking project…" : "Check whole project"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
