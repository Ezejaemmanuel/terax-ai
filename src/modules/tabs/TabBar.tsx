import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  Cancel01Icon,
  Clock01Icon,
  ComputerTerminal02Icon,
  GitBranchIcon,
  GitCompareIcon,
  Globe02Icon,
  IncognitoIcon,
  MapPinIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import type { EditorTab, Tab } from "./lib/useTabs";

const TAB_COLORS = [
  { label: "Red",    value: "#ef4444" },
  { label: "Orange", value: "#f97316" },
  { label: "Yellow", value: "#eab308" },
  { label: "Green",  value: "#22c55e" },
  { label: "Teal",   value: "#14b8a6" },
  { label: "Blue",   value: "#3b82f6" },
  { label: "Purple", value: "#a855f7" },
  { label: "Pink",   value: "#ec4899" },
] as const;

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onClose: (id: number) => void;
  /** Pin (promote) a preview tab to persistent on double-click. */
  onPin: (id: number) => void;
  /** Move a dragged tab to a new position (insertion gap index 0..tabs.length). */
  onReorder: (fromId: number, toGapIndex: number) => void;
  /** Lock/unlock a tab to the front of the tab bar. */
  onTogglePin: (id: number) => void;
  /** Set or clear the accent color stripe on a tab. */
  onSetColor: (id: number, color: string | null) => void;
  compact?: boolean;
};

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onClose,
  onPin,
  onReorder,
  onTogglePin,
  onSetColor,
  compact,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    fromId: number;
    active: boolean;
  } | null>(null);

  const gapAtX = (clientX: number) => {
    const els = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
    );
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  };

  const endDrag = (currentTarget: HTMLElement) => {
    const st = drag.current;
    if (st) currentTarget.releasePointerCapture?.(st.pointerId);
    drag.current = null;
    setDraggingId(null);
    setDropGap(null);
    document.body.style.userSelect = "";
  };

  // Live Claude Code / Codex status per terminal leaf — keyed by leafId.
  const agentSessions = useAgentStore((s: { sessions: Record<number, import("@/modules/agents/lib/types").AgentSession> }) => s.sessions);

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible after selection / open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region
      className="min-w-0 shrink overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          <TabsList className="h-7 w-max gap-0.5 bg-transparent p-0">
            {tabs.map((t, i) => {
              const isPreview = t.kind === "editor" && (t as EditorTab).preview;
              const srcIndex = tabs.findIndex((x) => x.id === draggingId);
              const showGap = (gap: number) =>
                draggingId !== null &&
                dropGap === gap &&
                gap !== srcIndex &&
                gap !== srcIndex + 1;
              // Show a separator between the last pinned tab and the first unpinned tab
              const prevTab = tabs[i - 1];
              const showPinnedSeparator = prevTab?.pinned && !t.pinned;
              return (
                <Fragment key={t.id}>
                  {showGap(i) && <DropIndicator />}
                  {showPinnedSeparator && (
                    <span className="mx-0.5 self-stretch w-px bg-border/50 shrink-0" aria-hidden />
                  )}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <TabsTrigger
                        value={String(t.id)}
                        data-tab-id={t.id}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
                          drag.current = {
                            pointerId: e.pointerId,
                            startX: e.clientX,
                            fromId: t.id,
                            active: false,
                          };
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          const st = drag.current;
                          if (!st || st.pointerId !== e.pointerId) return;
                          if (!st.active) {
                            if (Math.abs(e.clientX - st.startX) < 4) return;
                            st.active = true;
                            setDraggingId(st.fromId);
                            document.body.style.userSelect = "none";
                          }
                          e.preventDefault();
                          setDropGap(gapAtX(e.clientX));
                        }}
                        onPointerUp={(e) => {
                          const st = drag.current;
                          if (st?.active && dropGap !== null) {
                            onReorder(st.fromId, dropGap);
                          }
                          endDrag(e.currentTarget);
                        }}
                        onPointerCancel={(e) => endDrag(e.currentTarget)}
                        onDoubleClick={() => isPreview && onPin(t.id)}
                        onAuxClick={(e) => {
                          if (e.button === 1 && tabs.length > 1 && !t.pinned) {
                            e.preventDefault();
                            e.stopPropagation();
                            onClose(t.id);
                          }
                        }}
                        onMouseDown={(e) => {
                          if (e.button === 1) e.preventDefault();
                        }}
                        className={cn(
                          "group relative h-7 shrink-0 gap-1.5 rounded-md text-xs text-muted-foreground transition-colors data-[state=active]:bg-accent data-[state=active]:text-foreground hover:text-foreground/80 justify-between",
                          draggingId === t.id && "opacity-50",
                          compact
                            ? "px-1.5!"
                            : tabs.length === 1
                              ? "px-2!"
                              : "ps-2! pe-1!",
                        )}
                      >
                        {t.color && (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-y-1.5 left-0 w-[2.5px] rounded-full"
                            style={{ backgroundColor: t.color }}
                          />
                        )}
                        <span
                          className={cn(
                            "flex items-center gap-1.5 truncate",
                            compact ? "max-w-48" : "max-w-80",
                          )}
                        >
                          <TabIcon tab={t} />
                          <span className={cn("truncate", isPreview && "italic")}>
                            {labelFor(t)}
                          </span>
                          {t.kind === "editor" && t.dirty ? (
                            <span
                              aria-label="Unsaved changes"
                              className="size-1.5 shrink-0 rounded-full bg-foreground/70"
                            />
                          ) : null}
                          {/* Live Claude Code / Codex status dot */}
                          {t.kind === "terminal" && (() => {
                            const session = agentSessions[t.activeLeafId];
                            if (!session) return null;
                            return (
                              <span
                                aria-label={session.status === "waiting" ? "Waiting for input" : "Working"}
                                className={cn(
                                  "size-1.5 shrink-0 animate-pulse rounded-full",
                                  session.status === "waiting"
                                    ? "bg-amber-400"
                                    : "bg-emerald-500",
                                )}
                              />
                            );
                          })()}
                          {t.pinned ? (
                            <HugeiconsIcon
                              icon={MapPinIcon}
                              size={9}
                              strokeWidth={2}
                              className="shrink-0 text-muted-foreground/70"
                            />
                          ) : null}
                        </span>
                        {tabs.length > 1 && !t.pinned && (
                          <span
                            role="button"
                            aria-label="Close tab"
                            data-no-drag
                            onClick={(e) => {
                              e.stopPropagation();
                              onClose(t.id);
                            }}
                            className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
                          >
                            <HugeiconsIcon
                              icon={Cancel01Icon}
                              size={11}
                              strokeWidth={2}
                            />
                          </span>
                        )}
                      </TabsTrigger>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => onTogglePin(t.id)}>
                        {t.pinned ? "Unpin tab" : "Pin tab"}
                      </ContextMenuItem>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>Set color</ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          <div className="grid grid-cols-4 gap-1 p-1">
                            {TAB_COLORS.map((c) => (
                              <button
                                key={c.value}
                                title={c.label}
                                data-no-drag
                                onClick={() => onSetColor(t.id, c.value)}
                                className="size-5 rounded-full ring-1 ring-transparent hover:ring-foreground/30 cursor-pointer"
                                style={{ backgroundColor: c.value }}
                              />
                            ))}
                          </div>
                          <ContextMenuSeparator />
                          <ContextMenuItem onSelect={() => onSetColor(t.id, null)}>
                            Clear color
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      {!t.pinned && tabs.length > 1 && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onSelect={() => onClose(t.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            Close tab
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
                  {i === tabs.length - 1 && showGap(tabs.length) && (
                    <DropIndicator />
                  )}
                </Fragment>
              );
            })}
          </TabsList>
        </Tabs>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="New tab"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => onNew()}>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Terminal</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "T")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPrivate()}>
              <HugeiconsIcon
                icon={IncognitoIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Privacy</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "R")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Editor</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "E")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPreview()}>
              <HugeiconsIcon icon={Globe02Icon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Preview</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "P")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewGitGraph()}>
              <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Git Graph</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function DropIndicator() {
  return (
    <span
      aria-hidden
      className="my-0.5 w-0.5 shrink-0 self-stretch rounded-full bg-primary"
    />
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "editor" || tab.kind === "markdown") {
    const url = fileIconUrl(tab.title);
    return url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null;
  }
  if (tab.kind === "preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "ai-diff" || tab.kind === "ai-session-diff") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-history") {
    return (
      <HugeiconsIcon
        icon={Clock01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}

function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "preview") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "ai-session-diff") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (!t.cwd) return t.title;
  const parts = t.cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
