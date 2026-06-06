import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ArrowRight01Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { motion } from "motion/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { GrepResponse, GrepHit } from "@/modules/ai/lib/native";
import { fileIconUrl } from "./lib/iconResolver";
import { copyToClipboard, revealInFinder } from "./lib/contextActions";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { cn } from "@/lib/utils";

const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 250;
const MAX_RESULTS = 1000;
const ROW_HEIGHT = 22;
const OVERSCAN = 12;
// Lines longer than this are clipped for display (offsets adjusted to match).
const MAX_LINE_DISPLAY = 280;

type Props = {
  rootPath: string;
  open: boolean;
  onRequestClose: () => void;
  onOpenFileAtLine: (path: string, line: number) => void;
  onActiveChange?: (active: boolean) => void;
};

export type ExplorerContentSearchHandle = {
  focus: () => void;
  isFocused: () => boolean;
};

type FileGroup = { path: string; rel: string; hits: GrepHit[] };

// Flattened row model so the long result list can be virtualized.
type Row =
  | { kind: "file"; key: string; group: FileGroup; collapsed: boolean }
  | { kind: "hit"; key: string; path: string; hit: GrepHit };

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// VSCode-style "files to include": bare extensions/names match anywhere in the
// tree, and a trailing slash means "everything under this directory".
function normalizeGlob(token: string): string {
  let t = token.trim();
  if (!t) return "";
  if (t.endsWith("/")) t = `${t}**`;
  if (!t.includes("/")) t = `**/${t}`;
  return t;
}

function basename(rel: string): string {
  const i = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
  return i >= 0 ? rel.slice(i + 1) : rel;
}

function dirname(rel: string): string {
  const i = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
  return i >= 0 ? rel.slice(0, i) : "";
}

// Left-trims indentation and clips overly long lines, shifting the match ranges
// so highlighting still lines up after the edit.
function prepareLine(hit: GrepHit): {
  text: string;
  ranges: [number, number][];
} {
  const trimmedStart = hit.text.length - hit.text.trimStart().length;
  let text = hit.text.slice(trimmedStart);
  let ranges = hit.submatches.map(
    ([a, b]) => [a - trimmedStart, b - trimmedStart] as [number, number],
  );
  if (text.length > MAX_LINE_DISPLAY) {
    text = `${text.slice(0, MAX_LINE_DISPLAY)}…`;
    ranges = ranges
      .filter(([a]) => a < MAX_LINE_DISPLAY)
      .map(([a, b]) => [a, Math.min(b, MAX_LINE_DISPLAY)] as [number, number]);
  }
  return { text, ranges };
}

// Splits a line into plain/highlighted segments from the match ranges.
function renderHighlighted(text: string, ranges: [number, number][]) {
  if (ranges.length === 0) return text;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  ranges
    .slice()
    .sort((a, b) => a[0] - b[0])
    .forEach(([start, end], i) => {
      const s = Math.max(0, Math.min(start, text.length));
      const e = Math.max(s, Math.min(end, text.length));
      if (s > cursor) out.push(text.slice(cursor, s));
      out.push(
        <span
          key={i}
          className="rounded-[2px] bg-yellow-500/30 text-foreground"
        >
          {text.slice(s, e)}
        </span>,
      );
      cursor = e;
    });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

export const ExplorerContentSearch = forwardRef<
  ExplorerContentSearchHandle,
  Props
>(function ExplorerContentSearch(
  { rootPath, open, onRequestClose, onOpenFileAtLine, onActiveChange }: Props,
  ref,
) {
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const [query, setQuery] = useState("");
  const [include, setInclude] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = query.trim().length > 0;

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setHits([]);
      setSearching(false);
      setTruncated(false);
      setError(null);
    }
  }, [open]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        requestAnimationFrame(() => inputRef.current?.focus());
      },
      isFocused: () => document.activeElement === inputRef.current,
    }),
    [],
  );

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_QUERY_LEN) {
      setHits([]);
      setSearching(false);
      setTruncated(false);
      setError(null);
      return;
    }
    setSearching(true);
    let alive = true;
    const handle = setTimeout(async () => {
      const pattern = useRegex ? q : escapeRegex(q);
      const globs = include
        .split(",")
        .map(normalizeGlob)
        .filter((g) => g.length > 0);
      try {
        const res = await invoke<GrepResponse>("fs_grep", {
          pattern,
          root: rootPath,
          glob: globs.length > 0 ? globs : null,
          caseInsensitive: !caseSensitive,
          wholeWord,
          maxResults: MAX_RESULTS,
          workspace: currentWorkspaceEnv(),
        });
        if (!alive) return;
        setHits(res.hits);
        setTruncated(res.truncated);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setHits([]);
        setTruncated(false);
        // Surface invalid-regex (and other) errors instead of a silent blank.
        setError(String(e));
      } finally {
        if (alive) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [query, rootPath, include, caseSensitive, wholeWord, useRegex, showHidden]);

  // Reset collapse state whenever a fresh result set arrives.
  useEffect(() => {
    setCollapsed(new Set());
  }, [hits]);

  const groups = useMemo<FileGroup[]>(() => {
    const map = new Map<string, FileGroup>();
    for (const hit of hits) {
      let g = map.get(hit.path);
      if (!g) {
        g = { path: hit.path, rel: hit.rel, hits: [] };
        map.set(hit.path, g);
      }
      g.hits.push(hit);
    }
    return [...map.values()];
  }, [hits]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups) {
      const isCollapsed = collapsed.has(g.path);
      out.push({
        kind: "file",
        key: `f:${g.path}`,
        group: g,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) {
        for (const hit of g.hits) {
          out.push({
            kind: "hit",
            key: `h:${g.path}:${hit.line}:${hit.submatches[0]?.[0] ?? 0}`,
            path: g.path,
            hit,
          });
        }
      }
    }
    return out;
  }, [groups, collapsed]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (i) => rows[i]?.key ?? i,
  });

  const toggleCollapsed = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const matchCount = hits.length;
  const fileCount = groups.length;

  return (
    <div className={cn("flex min-h-0 flex-col", active && "flex-1")}>
      {open ? (
        <motion.div
          className="shrink-0 px-2 py-1.5"
          initial={{ opacity: 0, transform: "translateY(-15px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
        >
          <div className="relative">
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRequestClose();
                }
              }}
              placeholder="Search"
              className="h-7 pr-20 text-xs"
            />
            <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5">
              <ToggleButton
                label="Match Case"
                active={caseSensitive}
                onClick={() => setCaseSensitive((v) => !v)}
              >
                Aa
              </ToggleButton>
              <ToggleButton
                label="Match Whole Word"
                active={wholeWord}
                onClick={() => setWholeWord((v) => !v)}
              >
                <span className="underline">ab</span>
              </ToggleButton>
              <ToggleButton
                label="Use Regular Expression"
                active={useRegex}
                onClick={() => setUseRegex((v) => !v)}
              >
                .*
              </ToggleButton>
            </div>
          </div>

          <Input
            value={include}
            onChange={(e) => setInclude(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onRequestClose();
              }
            }}
            placeholder="files to include  e.g. *.ts, src/"
            className="mt-1 h-6 text-[11px]"
          />
        </motion.div>
      ) : null}

      {active ? (
        <>
          <div className="flex items-center justify-between px-3 pb-1 text-[10px] text-muted-foreground">
            {error ? (
              <span className="truncate text-destructive" title={error}>
                {useRegex ? "Invalid regular expression" : error}
              </span>
            ) : searching && matchCount === 0 ? (
              <span>Searching…</span>
            ) : matchCount === 0 ? (
              <span>No results</span>
            ) : (
              <span>
                {matchCount} {matchCount === 1 ? "result" : "results"} in{" "}
                {fileCount} {fileCount === 1 ? "file" : "files"}
                {truncated ? " (partial)" : ""}
              </span>
            )}
          </div>

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
          >
            <div
              style={{
                height: virtualizer.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {virtualizer.getVirtualItems().map((vr) => {
                const row = rows[vr.index];
                if (!row) return null;
                return (
                  <div
                    key={vr.key}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: vr.size,
                      transform: `translateY(${vr.start}px)`,
                    }}
                  >
                    {row.kind === "file" ? (
                      <FileRow
                        group={row.group}
                        collapsed={row.collapsed}
                        onToggle={() => toggleCollapsed(row.group.path)}
                        onRevealInFinder={() => void revealInFinder(row.group.path)}
                        onCopyPath={() => void copyToClipboard(row.group.path)}
                      />
                    ) : (
                      <HitRow
                        hit={row.hit}
                        onClick={() =>
                          onOpenFileAtLine(row.path, row.hit.line)
                        }
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
});

function ToggleButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded text-[10px] font-medium leading-none transition-colors",
        active
          ? "bg-accent text-foreground ring-1 ring-primary/50"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function FileRow({
  group,
  collapsed,
  onToggle,
  onRevealInFinder,
  onCopyPath,
}: {
  group: FileGroup;
  collapsed: boolean;
  onToggle: () => void;
  onRevealInFinder: () => void;
  onCopyPath: () => void;
}) {
  const name = basename(group.rel);
  const dir = dirname(group.rel);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-1 px-1.5 py-0.5 text-left text-xs hover:bg-accent/50"
          title={group.rel}
        >
          <HugeiconsIcon
            icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
            size={13}
            strokeWidth={2}
            className="shrink-0 text-muted-foreground"
          />
          <img src={fileIconUrl(name)} alt="" className="size-3.5 shrink-0" />
          <span className="truncate text-foreground/90">{name}</span>
          {dir ? (
            <span className="truncate text-[10px] text-muted-foreground">
              {dir}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
            {group.hits.length}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className={COMPACT_CONTENT}>
        <ContextMenuItem className={COMPACT_ITEM} onSelect={onRevealInFinder}>
          Reveal in Finder
        </ContextMenuItem>
        <ContextMenuItem className={COMPACT_ITEM} onSelect={onCopyPath}>
          Copy Path
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function HitRow({ hit, onClick }: { hit: GrepHit; onClick: () => void }) {
  const { text, ranges } = useMemo(() => prepareLine(hit), [hit]);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 py-0.5 pr-2 pl-7 text-left text-xs hover:bg-accent/50"
      title={`Line ${hit.line}`}
    >
      <span className="truncate whitespace-pre font-mono text-foreground/80">
        {renderHighlighted(text, ranges)}
      </span>
    </button>
  );
}
