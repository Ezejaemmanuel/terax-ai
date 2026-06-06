import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useState } from "react";
import { InlineInput } from "./InlineInput";
import {
  copyToClipboard,
  relativePath,
  revealInFinder,
} from "./lib/contextActions";
import { colorClassFor, type GitDecoration } from "./lib/gitDecoration";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import type { useFileTree } from "./lib/useFileTree";
import type { SelectMods } from "./lib/useSelection";

type Tree = ReturnType<typeof useFileTree>;

export type EntryRowProps = {
  path: string;
  name: string;
  isDir: boolean;
  isExpanded: boolean;
  depth: number;
  rootPath: string;
  tree: Tree;
  isSelected: boolean;
  isRenaming: boolean;
  /** This row's path is on the clipboard in "cut" mode — render it dimmed. */
  isCut: boolean;
  /** The clipboard holds something, so Paste is available. */
  canPaste: boolean;
  /** A drag is in progress and this folder is the current drop target. */
  isDropTarget: boolean;
  gitStatus?: GitDecoration;
  onOpenFile: (path: string, pin?: boolean) => void;
  onSelectPath: (path: string, mods?: SelectMods) => void;
  /** Copy/cut the current selection (this row is part of it after right-click). */
  onCopy: () => void;
  onCut: () => void;
  /** Paste the clipboard into the given directory. */
  onPaste: (targetDir: string) => void;
  /** Resolve the set of paths a drag starting on this row should carry. */
  onDragPaths: (path: string) => string[];
  /** Begin a pointer-driven drag of `sources`. */
  onDragStart: (e: React.PointerEvent, sources: string[]) => void;
  /** True if a drag just ended, so the trailing click is ignored. */
  didDrag: () => boolean;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  onOpenMarkdownPreview?: (path: string) => void;
};

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function EntryRowImpl(props: EntryRowProps) {
  const {
    path,
    name,
    isDir,
    isExpanded,
    depth,
    rootPath,
    tree,
    isSelected,
    isRenaming,
    isCut,
    canPaste,
    isDropTarget,
    gitStatus,
    onOpenFile,
    onSelectPath,
    onCopy,
    onCut,
    onPaste,
    onDragPaths,
    onDragStart,
    didDrag,
    onRevealInTerminal,
    onAttachToAgent,
    onOpenMarkdownPreview,
  } = props;

  const [isConfirming, setIsConfirming] = useState(false);
  const iconUrl = isDir ? folderIconUrl(name, isExpanded) : fileIconUrl(name);
  const createTarget = isDir ? path : path.slice(0, path.lastIndexOf("/")) || rootPath;
  const paddingLeft = 6 + depth * 12;

  const handleClick = (e: React.MouseEvent) => {
    if (tree.renaming) return;
    // The pointerup that ends a drag also fires a click — ignore it.
    if (didDrag()) return;
    const additive = e.ctrlKey || e.metaKey;
    const range = e.shiftKey;
    onSelectPath(path, { additive, range });
    // A multi-select gesture only adjusts the selection — it must not open the
    // file or expand the folder (matches VS Code).
    if (additive || range) return;
    if (isDir) tree.toggle(path);
    else onOpenFile(path);
  };

  // Right-clicking a row that isn't part of the selection selects just it, so
  // context-menu actions always operate on what the user clicked.
  const handleContextMenu = () => {
    if (!isSelected) onSelectPath(path);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (tree.renaming) return;
    onDragStart(e, onDragPaths(path));
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {isRenaming ? (
          <div
            className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
            style={{ paddingLeft }}
          >
            <span className="size-3.5 shrink-0" />
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <InlineInput
              initial={name}
              onCommit={tree.commitRename}
              onCancel={tree.cancelRename}
            />
          </div>
        ) : (
          <button
            type="button"
            data-fs-path={path}
            data-fs-dir={isDir ? "1" : "0"}
            onClick={handleClick}
            onContextMenu={handleContextMenu}
            onDoubleClick={() => !isDir && tree.beginRename(path)}
            onPointerDown={handlePointerDown}
            className={cn(
              "group flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-[13px] text-foreground/85 transition-colors hover:bg-accent/70",
              isSelected && "bg-accent text-foreground",
              isCut && "opacity-50",
              isDropTarget && "ring-1 ring-inset ring-primary bg-accent/60",
            )}
            style={{ paddingLeft }}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
              {isDir ? (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={12}
                  strokeWidth={2.25}
                  className={cn(
                    "transition-transform",
                    isExpanded && "rotate-90",
                  )}
                />
              ) : null}
            </span>
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                // Selection highlight owns the text color for contrast against
                // the accent background; the badge still carries the git color.
                gitStatus && !isSelected && colorClassFor(gitStatus.status),
              )}
            >
              {name}
            </span>
            {gitStatus ? (
              <span
                className={cn(
                  "shrink-0 pl-1 text-[11px] font-semibold leading-none tabular-nums",
                  colorClassFor(gitStatus.status),
                )}
                aria-hidden
              >
                {gitStatus.badge}
              </span>
            ) : null}
          </button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent
        className={COMPACT_CONTENT}
        onCloseAutoFocus={(e) => {
          if (tree.renaming || tree.pendingCreate) e.preventDefault();
        }}
      >
        {!isDir && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenFile(path, true)}
          >
            Open
          </ContextMenuItem>
        )}
        {!isDir && isMarkdownPath(path) && onOpenMarkdownPreview && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenMarkdownPreview(path)}
          >
            Open Preview
          </ContextMenuItem>
        )}
        {isDir && onRevealInTerminal && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onRevealInTerminal(path)}
          >
            Open in Terminal
          </ContextMenuItem>
        )}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void revealInFinder(path)}
        >
          Reveal in Finder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className={COMPACT_ITEM} onSelect={onCut}>
          Cut
        </ContextMenuItem>
        <ContextMenuItem className={COMPACT_ITEM} onSelect={onCopy}>
          Copy
        </ContextMenuItem>
        {canPaste && (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onPaste(createTarget)}
          >
            Paste
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => tree.beginCreate(createTarget, "file")}
        >
          New File
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => tree.beginCreate(createTarget, "dir")}
        >
          New Folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(path)}
        >
          Copy Path
        </ContextMenuItem>
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(relativePath(rootPath, path))}
        >
          Copy Relative Path
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => onAttachToAgent?.(path)}
        >
          Attach to Agent
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className={COMPACT_ITEM}
          variant="destructive"
          onSelect={(e) => {
            e.preventDefault();
            if (isConfirming) {
              void tree.deletePath(path);
            } else {
              setIsConfirming(true);
            }
          }}
          onMouseLeave={() => setTimeout(() => setIsConfirming(false), 1500)}
        >
          {isConfirming ? "Click again to confirm" : "Delete"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const EntryRow = memo(EntryRowImpl);

export type PendingRowProps = {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
};

export function PendingRow({ depth, kind, onCommit, onCancel }: PendingRowProps) {
  return (
    <div
      className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="size-3.5 shrink-0" />
      <img
        src={kind === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")}
        alt=""
        className="size-4 shrink-0 opacity-70"
      />
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? "New folder" : "New file"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function StatusRow({
  depth,
  message,
  tone,
}: {
  depth: number;
  message: string;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "h-6 truncate px-2 text-[11px] leading-6",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ paddingLeft: 6 + depth * 12 + 18 }}
    >
      {message}
    </div>
  );
}
