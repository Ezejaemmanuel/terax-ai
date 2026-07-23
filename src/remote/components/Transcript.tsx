import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { MessageBlock } from "@/remote/components/MessageBlock";
import { buildRows, type Row as TranscriptRow } from "@/remote/lib/mergeTranscript";
import type { Message } from "@/remote/lib/types";

/// Rough first guess; every row is measured after mount.
const ESTIMATED_ROW = 140;
/// Distance from the bottom still counted as "following along".
const STICK_SLACK = 80;

function roleLabel(role: TranscriptRow["role"]) {
  return role === "assistant" ? "agent" : role;
}

function Row({ row }: { row: TranscriptRow }) {
  const isUser = row.role === "user";
  return (
    <div className="px-3 py-2 sm:px-5">
      <div
        className={cn(
          "mb-1 text-[10px] font-medium uppercase tracking-wider",
          isUser ? "text-foreground/70" : "text-muted-foreground",
        )}
      >
        {roleLabel(row.role)}
      </div>
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm",
          isUser
            ? "border-border bg-muted/50"
            : "border-transparent bg-transparent",
        )}
      >
        {row.blocks.map((block, i) => (
          <MessageBlock key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

export function Transcript({
  messages,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: {
  messages: Message[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const rows = useMemo(() => buildRows(messages), [messages]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const countRef = useRef(rows.length);
  // Scroll anchoring when older messages are prepended.
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const initialScrollDone = useRef(false);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW,
    getItemKey: (i) => rows[i]?.id ?? i,
    overscan: 6,
  });

  const scrollToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el || rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
    // Virtual rows may not be measured yet; force the native scroller too.
    requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, [rows.length, virtualizer]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance <= STICK_SLACK);
    if (el.scrollTop < 200 && hasMore && !loadingOlder) {
      anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
      onLoadOlder();
    }
  }, [hasMore, loadingOlder, onLoadOlder]);

  // New chat / first page: land at the bottom so the latest turn is in view and
  // the user scrolls up for history.
  useLayoutEffect(() => {
    if (initialScrollDone.current || rows.length === 0) return;
    initialScrollDone.current = true;
    setAtBottom(true);
    scrollToLatest();
  }, [rows.length, scrollToLatest]);

  // Prepending older messages would otherwise yank the viewport to a different
  // part of the conversation.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    if (rows.length > countRef.current) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      anchorRef.current = null;
    }
  }, [rows.length]);

  useEffect(() => {
    const grew = rows.length > countRef.current;
    countRef.current = rows.length;
    if (grew && atBottom && rows.length > 0 && initialScrollDone.current) {
      scrollToLatest();
    }
  }, [rows.length, atBottom, scrollToLatest]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto overscroll-contain"
      >
        {hasMore && (
          <div className="py-2 text-center text-xs text-muted-foreground">
            {loadingOlder ? "loading older…" : "scroll up for older messages"}
          </div>
        )}
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {items.map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              <Row row={rows[item.index]} />
            </div>
          ))}
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={scrollToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1.5 text-xs shadow-lg"
        >
          jump to latest
        </button>
      )}
    </div>
  );
}
