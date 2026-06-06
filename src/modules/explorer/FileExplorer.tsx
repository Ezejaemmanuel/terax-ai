import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  FileAddIcon,
  FileSearchIcon,
  Folder01Icon,
  FolderAddIcon,
  Refresh01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExplorerSearch, type ExplorerSearchHandle } from "./ExplorerSearch";
import {
  ExplorerContentSearch,
  type ExplorerContentSearchHandle,
} from "./ExplorerContentSearch";
import { cn } from "@/lib/utils";
import { EntryRow, PendingRow, StatusRow } from "./TreeRow";
import {
  PasteConfirmDialog,
  type PendingOsPaste,
} from "./PasteConfirmDialog";
import { InlineInput } from "./InlineInput";
import { readOsClipboardFiles } from "./lib/osClipboard";
import { useTreeDrag } from "./lib/useTreeDrag";
import { copyToClipboard, revealInFinder } from "./lib/contextActions";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { useFileTree } from "./lib/useFileTree";
import { useSelection } from "./lib/useSelection";
import { useExplorerClipboard } from "./lib/useExplorerClipboard";
import { useGitDecorations } from "./lib/useGitDecorations";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import type { SourceControlSummary } from "@/modules/source-control";

export type FileExplorerHandle = {
  focus: () => void;
  isFocused: () => boolean;
};

type Props = {
  rootPath: string | null;
  sourceControl: SourceControlSummary;
  onOpenFile: (path: string, pin?: boolean) => void;
  onOpenFileAtLine?: (path: string, line: number) => void;
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  onOpenMarkdownPreview?: (path: string) => void;
};

type Row =
  | {
      kind: "entry";
      key: string;
      path: string;
      name: string;
      isDir: boolean;
      isExpanded: boolean;
      depth: number;
    }
  | { kind: "rename"; key: string; path: string; name: string; isDir: boolean; depth: number }
  | { kind: "pending"; key: string; depth: number; pendingKind: "file" | "dir" }
  | { kind: "status"; key: string; depth: number; tone: "muted" | "error"; message: string };

const ROW_HEIGHT = 24;
const OVERSCAN = 8;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function buildRows(
  rootPath: string,
  tree: ReturnType<typeof useFileTree>,
): { rows: Row[]; entryIndexByPath: Map<string, number> } {
  const rows: Row[] = [];
  const entryIndexByPath = new Map<string, number>();

  const walk = (parent: string, depth: number) => {
    const node = tree.nodes[parent];
    if (!node || node.status !== "loaded") return;
    const sorted = [...node.entries].sort((a, b) => {
      const aDir = a.kind === "dir" ? 0 : 1;
      const bDir = b.kind === "dir" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const entry of sorted) {
      const path = tree.joinPath(parent, entry.name);
      const isDir = entry.kind === "dir";
      const expanded = isDir && tree.expanded.has(path);
      const isRenaming = tree.renaming === path;
      if (isRenaming) {
        rows.push({
          kind: "rename",
          key: `rename:${path}`,
          path,
          name: entry.name,
          isDir,
          depth,
        });
      } else {
        entryIndexByPath.set(path, rows.length);
        rows.push({
          kind: "entry",
          key: path,
          path,
          name: entry.name,
          isDir,
          isExpanded: expanded,
          depth,
        });
      }
      if (isDir && expanded) {
        const child = tree.nodes[path];
        if (tree.pendingCreate?.parentPath === path) {
          rows.push({
            kind: "pending",
            key: `pending:${path}`,
            depth: depth + 1,
            pendingKind: tree.pendingCreate.kind,
          });
        }
        if (child?.status === "loading") {
          rows.push({
            kind: "status",
            key: `loading:${path}`,
            depth: depth + 1,
            tone: "muted",
            message: "Loading…",
          });
        } else if (child?.status === "error") {
          rows.push({
            kind: "status",
            key: `error:${path}`,
            depth: depth + 1,
            tone: "error",
            message: child.message,
          });
        } else if (child?.status === "loaded") {
          walk(path, depth + 1);
        }
      }
    }
  };

  walk(rootPath, 0);
  return { rows, entryIndexByPath };
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(
  function FileExplorer(
    {
      rootPath,
      sourceControl,
      onOpenFile,
      onOpenFileAtLine,
      onPathRenamed,
      onPathDeleted,
      onRevealInTerminal,
      onAttachToAgent,
      onOpenMarkdownPreview,
    },
    ref,
  ) {
    const tree = useFileTree(rootPath, { onPathRenamed, onPathDeleted });
    const git = useGitDecorations(sourceControl);
    // Two distinct search surfaces (VSCode-style): "content" greps file text,
    // "file" matches filenames. Only one is open at a time; "none" shows the tree.
    const [searchMode, setSearchMode] = useState<"none" | "content" | "file">(
      "none",
    );
    const [isSearchActive, setIsSearchActive] = useState(false);
    const [pendingPaste, setPendingPaste] = useState<PendingOsPaste | null>(null);
    // Folder under the cursor during an OS (Explorer/Finder) file drag.
    const [osDropTarget, setOsDropTarget] = useState<string | null>(null);
    const searchRef = useRef<ExplorerSearchHandle>(null);
    const contentSearchRef = useRef<ExplorerContentSearchHandle>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    const { rows, entryIndexByPath } = useMemo(() => {
      if (!rootPath) return { rows: [] as Row[], entryIndexByPath: new Map<string, number>() };
      return buildRows(rootPath, tree);
    }, [rootPath, tree.nodes, tree.expanded, tree.renaming, tree.pendingCreate, tree]);

    const entryPaths = useMemo<string[]>(() => {
      const out: string[] = [];
      for (const row of rows) if (row.kind === "entry") out.push(row.path);
      return out;
    }, [rows]);

    const { selected, lead, select, moveLead, setLead, prune } =
      useSelection(entryPaths);

    // Drop selected/lead paths that vanished (collapse, delete, rename).
    useEffect(() => {
      prune((p) => entryIndexByPath.has(p));
    }, [entryIndexByPath, prune]);

    const virtualizer = useVirtualizer({
      count: rows.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: OVERSCAN,
      getItemKey: (index) => rows[index]?.key ?? index,
    });

    const scrollEntryIntoView = useCallback(
      (path: string) => {
        const index = entryIndexByPath.get(path);
        if (index === undefined) return;
        virtualizer.scrollToIndex(index, { align: "auto" });
      },
      [entryIndexByPath, virtualizer],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => {
          containerRef.current?.focus();
          if (!lead && entryPaths.length > 0) setLead(entryPaths[0]);
        },
        isFocused: () => {
          const c = containerRef.current;
          if (!c) return false;
          const active = document.activeElement;
          return active instanceof Node && c.contains(active);
        },
      }),
      [entryPaths, lead, setLead],
    );

    // Keep the active row visible as the lead moves (keyboard nav, focus-first).
    useEffect(() => {
      if (lead) scrollEntryIntoView(lead);
    }, [lead, scrollEntryIntoView]);

    const clipboard = useExplorerClipboard();
    const { pasteInto: treePasteInto } = tree;
    // Rows currently "cut" are dimmed until the paste lands (or is cancelled).
    const cutPaths = useMemo(
      () => (clipboard.mode === "cut" ? new Set(clipboard.entries) : null),
      [clipboard.mode, clipboard.entries],
    );

    const placeOnClipboard = useCallback(
      (mode: "copy" | "cut") => {
        const paths = selected.size > 0 ? [...selected] : lead ? [lead] : [];
        if (paths.length > 0) clipboard.set(paths, mode);
      },
      [selected, lead, clipboard],
    );
    // Stable identities so `memo`-ized rows don't re-render on every keystroke.
    const copySelection = useCallback(() => placeOnClipboard("copy"), [placeOnClipboard]);
    const cutSelection = useCallback(() => placeOnClipboard("cut"), [placeOnClipboard]);

    const runInternalPaste = useCallback(
      (targetDir: string) => {
        const { entries, mode } = clipboard;
        if (entries.length === 0 || !mode) return;
        void treePasteInto(targetDir, entries, mode).then(() => {
          if (mode === "cut") clipboard.clear();
        });
      },
      [clipboard, treePasteInto],
    );

    // Files copied outside the app (Explorer/Finder) take precedence; the
    // confirm dialog is the safety net if the OS clipboard is unexpectedly
    // stale. With no external files we fall back to the in-app clipboard.
    const pasteInto = useCallback(
      (targetDir: string) => {
        void readOsClipboardFiles().then((osFiles) => {
          if (osFiles.length > 0) setPendingPaste({ targetDir, sources: osFiles });
          else runInternalPaste(targetDir);
        });
      },
      [runInternalPaste],
    );

    const confirmOsPaste = useCallback(() => {
      setPendingPaste((p) => {
        if (p) void treePasteInto(p.targetDir, p.sources, "copy");
        return null;
      });
    }, [treePasteInto]);

    // Dragging a row that's part of a multi-selection drags the whole
    // selection; otherwise just the row under the cursor.
    const dragSourcesFor = useCallback(
      (path: string): string[] =>
        selected.has(path) && selected.size > 1 ? [...selected] : [path],
      [selected],
    );

    const dropEntries = useCallback(
      (targetDir: string, sources: string[], copy: boolean) => {
        void treePasteInto(targetDir, sources, copy ? "copy" : "cut");
      },
      [treePasteInto],
    );

    // Internal drag is pointer-driven (HTML5 DnD is suppressed by Tauri's native
    // drag-drop handler). The overlay follows the cursor; the hook resolves the
    // drop folder from the DOM and performs the move/copy on release.
    const overlayRef = useRef<HTMLDivElement>(null);
    const drag = useTreeDrag({
      containerRef,
      overlayRef,
      rootPath,
      onExpand: tree.expand,
      onDrop: dropEntries,
    });

    // A file pastes into its parent; a folder pastes into itself (VS Code).
    const pasteTargetFor = useCallback(
      (path: string): string => {
        const idx = entryIndexByPath.get(path);
        const row = idx === undefined ? undefined : rows[idx];
        if (row && row.kind === "entry" && row.isDir) return path;
        const parent = path.slice(0, path.lastIndexOf("/"));
        return parent || (rootPath ?? path);
      },
      [entryIndexByPath, rows, rootPath],
    );

    // Files dragged in from the OS (Explorer/Finder) arrive via Tauri's native
    // drag-drop event with a window-relative physical position. We hit-test it
    // against the tree to find the folder under the cursor.
    const resolveOsTargetDir = useCallback(
      (clientX: number, clientY: number): string | null => {
        const container = containerRef.current;
        if (!container || !rootPath) return null;
        const r = container.getBoundingClientRect();
        // The event fires for the whole window — ignore points outside this panel.
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom)
          return null;
        const el = document.elementFromPoint(clientX, clientY);
        const rowPath = el?.closest<HTMLElement>("[data-fs-path]")?.getAttribute("data-fs-path");
        return rowPath ? pasteTargetFor(rowPath) : rootPath;
      },
      [rootPath, pasteTargetFor],
    );

    const handleOsOver = useCallback(
      (clientX: number, clientY: number) => {
        const dir = resolveOsTargetDir(clientX, clientY);
        setOsDropTarget((cur) => (cur === dir ? cur : dir));
      },
      [resolveOsTargetDir],
    );

    const handleOsDrop = useCallback(
      (paths: string[], clientX: number, clientY: number) => {
        const targetDir = resolveOsTargetDir(clientX, clientY);
        setOsDropTarget(null);
        if (targetDir) setPendingPaste({ targetDir, sources: paths });
      },
      [resolveOsTargetDir],
    );

    const osRef = useRef({ handleOsOver, handleOsDrop });
    useEffect(() => {
      osRef.current = { handleOsOver, handleOsDrop };
    }, [handleOsOver, handleOsDrop]);

    // Subscribe once; the ref keeps the handlers current without re-subscribing.
    useEffect(() => {
      let alive = true;
      let unlisten: (() => void) | undefined;
      const scaled = (n: number) => n / (window.devicePixelRatio || 1);
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") {
            osRef.current.handleOsOver(scaled(p.position.x), scaled(p.position.y));
          } else if (p.type === "drop") {
            if (p.paths && p.paths.length > 0) {
              osRef.current.handleOsDrop(p.paths, scaled(p.position.x), scaled(p.position.y));
            } else {
              setOsDropTarget(null);
            }
          } else if (p.type === "leave") {
            setOsDropTarget(null);
          }
        })
        .then((un) => {
          if (alive) unlisten = un;
          else un();
        });
      return () => {
        alive = false;
        unlisten?.();
      };
    }, []);

    const openContentSearch = () => {
      if (searchMode === "content" && contentSearchRef.current?.isFocused()) {
        setSearchMode("none");
        setIsSearchActive(false);
        return;
      }
      setSearchMode("content");
      contentSearchRef.current?.focus();
    };

    const openFileSearch = () => {
      if (searchMode === "file" && searchRef.current?.isFocused()) {
        setSearchMode("none");
        setIsSearchActive(false);
        return;
      }
      setSearchMode("file");
      searchRef.current?.focus();
    };

    useGlobalShortcuts({
      // Cmd/Ctrl+Shift+F → content search, matching VSCode.
      "explorer.search": openContentSearch,
      // Cmd/Ctrl+P → filename search ("Go to File").
      "explorer.fileSearch": openFileSearch,
    });

    if (!rootPath) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <HugeiconsIcon
            icon={Folder01Icon}
            size={24}
            strokeWidth={1.5}
            className="text-muted-foreground"
          />
          <div className="text-xs text-muted-foreground">
            No current directory
          </div>
        </div>
      );
    }

    const root = tree.nodes[rootPath];
    const pendingAtRoot =
      tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (tree.renaming || tree.pendingCreate || searchMode !== "none") return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      )
        return;

      // Clipboard shortcuts work even on an empty tree (paste into root).
      // Lower-case the key so Caps Lock / layout quirks (e.g. "C") still match.
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === "c") {
          e.preventDefault();
          copySelection();
          return;
        }
        if (key === "x") {
          e.preventDefault();
          cutSelection();
          return;
        }
        if (key === "v") {
          e.preventDefault();
          pasteInto(lead ? pasteTargetFor(lead) : rootPath);
          return;
        }
      }

      if (entryPaths.length === 0) return;

      const leadRow = (): Extract<Row, { kind: "entry" }> | null => {
        if (!lead) return null;
        const idx = entryIndexByPath.get(lead);
        const row = idx === undefined ? undefined : rows[idx];
        return row && row.kind === "entry" ? row : null;
      };

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveLead(1, e.shiftKey);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveLead(-1, e.shiftKey);
          break;
        case "ArrowRight": {
          const row = leadRow();
          if (!row) return;
          e.preventDefault();
          if (row.isDir) {
            if (!row.isExpanded) tree.toggle(row.path);
            else moveLead(1, false);
          }
          break;
        }
        case "ArrowLeft": {
          const row = leadRow();
          if (!row) return;
          e.preventDefault();
          if (row.isDir && row.isExpanded) {
            tree.toggle(row.path);
          } else {
            const parent = row.path.slice(0, row.path.lastIndexOf("/"));
            if (parent && parent !== rootPath) setLead(parent);
          }
          break;
        }
        case "Enter": {
          const row = leadRow();
          if (!row) return;
          e.preventDefault();
          if (row.isDir) tree.toggle(row.path);
          else onOpenFile(row.path);
          break;
        }
      }
    };

    const renderRow = (row: Row) => {
      switch (row.kind) {
        case "entry":
        case "rename": {
          return (
            <EntryRow
              path={row.path}
              name={row.name}
              isDir={row.isDir}
              isExpanded={row.kind === "entry" ? row.isExpanded : false}
              depth={row.depth}
              rootPath={rootPath}
              tree={tree}
              isSelected={selected.has(row.path)}
              isRenaming={row.kind === "rename"}
              isCut={cutPaths?.has(row.path) ?? false}
              canPaste={clipboard.entries.length > 0}
              isDropTarget={
                row.isDir &&
                (drag.state.targetDir === row.path || osDropTarget === row.path)
              }
              gitStatus={
                row.kind === "entry" ? git.decorationFor(row.path) : undefined
              }
              onOpenFile={onOpenFile}
              onSelectPath={select}
              onCopy={copySelection}
              onCut={cutSelection}
              onPaste={pasteInto}
              onDragPaths={dragSourcesFor}
              onDragStart={drag.onPointerDown}
              didDrag={drag.didDrag}
              onRevealInTerminal={onRevealInTerminal}
              onAttachToAgent={onAttachToAgent}
              onOpenMarkdownPreview={onOpenMarkdownPreview}
            />
          );
        }
        case "pending":
          return (
            <PendingRow
              depth={row.depth}
              kind={row.pendingKind}
              onCommit={tree.commitCreate}
              onCancel={tree.cancelCreate}
            />
          );
        case "status":
          return (
            <StatusRow depth={row.depth} message={row.message} tone={row.tone} />
          );
      }
    };

    return (
      <div
        ref={containerRef}
        className="flex h-full flex-col outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/60 px-2">
          <span
            className="flex flex-1 items-center truncate text-xs font-medium text-foreground/80"
            title={rootPath}
          >
            <img
              src={folderIconUrl(basename(rootPath), false)}
              alt=""
              height={15}
              width={15}
              className="mx-1.5"
            />
            {basename(rootPath)}
          </span>

          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "size-6 text-muted-foreground hover:text-foreground",
              searchMode === "content" && "bg-accent text-foreground",
            )}
            onClick={openContentSearch}
            title="Search in files"
            aria-label="Search in files"
          >
            <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={2} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "size-6 text-muted-foreground hover:text-foreground",
              searchMode === "file" && "bg-accent text-foreground",
            )}
            onClick={openFileSearch}
            title="Find file by name"
            aria-label="Find file by name"
          >
            <HugeiconsIcon icon={FileSearchIcon} size={13} strokeWidth={2} />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.beginCreate(rootPath, "file")}
            title="New file"
          >
            <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => tree.beginCreate(rootPath, "dir")}
            title="New folder"
          >
            <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => {
              tree.refresh(rootPath);
              git.refreshGit();
            }}
            title="Refresh"
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
          </Button>
        </div>

        <ExplorerContentSearch
          ref={contentSearchRef}
          rootPath={rootPath}
          open={searchMode === "content"}
          onRequestClose={() => {
            setSearchMode("none");
            setIsSearchActive(false);
          }}
          onOpenFileAtLine={(path, line) => {
            if (onOpenFileAtLine) onOpenFileAtLine(path, line);
            else onOpenFile(path);
          }}
          onActiveChange={setIsSearchActive}
        />

        <ExplorerSearch
          ref={searchRef}
          rootPath={rootPath}
          onOpenFile={onOpenFile}
          open={searchMode === "file"}
          onRequestClose={() => {
            setSearchMode("none");
            setIsSearchActive(false);
          }}
          onActiveChange={setIsSearchActive}
          onRevealInTerminal={onRevealInTerminal}
          onAttachToAgent={onAttachToAgent}
        />

        {!isSearchActive ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={scrollRef}
                className={cn(
                  "min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
                  // Ring the panel when a drag would drop into the root folder
                  // (internal pointer drag or an OS file drag).
                  ((drag.state.active && drag.state.targetDir === rootPath) ||
                    osDropTarget === rootPath) &&
                    "ring-1 ring-inset ring-primary",
                )}
              >
                {pendingAtRoot ? (
                  <div
                    className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
                    style={{ paddingLeft: 6 }}
                  >
                    <span className="size-3.5 shrink-0" />
                    <img
                      src={
                        pendingAtRoot.kind === "dir"
                          ? folderIconUrl("", false)
                          : fileIconUrl("untitled")
                      }
                      alt=""
                      className="size-4 shrink-0 opacity-70"
                    />
                    <InlineInput
                      initial=""
                      placeholder={
                        pendingAtRoot.kind === "dir" ? "New folder" : "New file"
                      }
                      onCommit={tree.commitCreate}
                      onCancel={tree.cancelCreate}
                    />
                  </div>
                ) : null}
                {root?.status === "loading" && (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Loading…
                  </div>
                )}
                {root?.status === "error" && (
                  <div className="px-3 py-2 text-[11px] text-destructive">
                    {root.message}
                  </div>
                )}
                {root?.status === "loaded" ? (
                  <div
                    style={{
                      height: virtualizer.getTotalSize(),
                      position: "relative",
                      width: "100%",
                    }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          data-virtual-row-index={virtualRow.index}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: virtualRow.size,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          {renderRow(row)}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent
              className={COMPACT_CONTENT}
              onCloseAutoFocus={(e) => {
                if (tree.renaming || tree.pendingCreate) e.preventDefault();
              }}
            >
              {onRevealInTerminal && (
                <ContextMenuItem
                  className={COMPACT_ITEM}
                  onSelect={() => onRevealInTerminal(rootPath)}
                >
                  Open in Terminal
                </ContextMenuItem>
              )}
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void revealInFinder(rootPath)}
              >
                Reveal in Finder
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => tree.beginCreate(rootPath, "file")}
              >
                New File
              </ContextMenuItem>
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => tree.beginCreate(rootPath, "dir")}
              >
                New Folder
              </ContextMenuItem>
              {clipboard.entries.length > 0 && (
                <ContextMenuItem
                  className={COMPACT_ITEM}
                  onSelect={() => pasteInto(rootPath)}
                >
                  Paste
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => void copyToClipboard(rootPath)}
              >
                Copy Path
              </ContextMenuItem>
              <ContextMenuItem
                className={COMPACT_ITEM}
                onSelect={() => {
                  tree.refresh(rootPath);
                  git.refreshGit();
                }}
              >
                Refresh
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : null}

        <PasteConfirmDialog
          pending={pendingPaste}
          onConfirm={confirmOsPaste}
          onCancel={() => setPendingPaste(null)}
        />

        {drag.state.active && (
          <div
            ref={overlayRef}
            className="pointer-events-none fixed left-0 top-0 z-50 rounded-sm border border-border/60 bg-popover px-2 py-0.5 text-[12px] text-foreground shadow-md"
            style={{
              transform: `translate(${drag.pointerRef.current.x + 12}px, ${drag.pointerRef.current.y + 8}px)`,
            }}
          >
            {drag.state.copy ? "Copy " : ""}
            {drag.state.label}
          </div>
        )}
      </div>
    );
  },
);
