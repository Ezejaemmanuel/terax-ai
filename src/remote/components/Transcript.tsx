import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MessageBlock } from "@/remote/components/MessageBlock";
import type { Message } from "@/remote/lib/types";

/// Rough first guess; every row is measured after mount.
const ESTIMATED_ROW = 140;
/// Distance from the bottom still counted as "following along".
const STICK_SLACK = 80;

function roleLabel(role: Message["role"]) {
  return role === "assistant" ? "agent" : role;
}

function Row({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className="px-3 py-2 sm:px-5">
      <div
        className={cn(
          "mb-1 text-[10px] font-medium uppercase tracking-wider",
          isUser ? "text-foreground/70" : "text-muted-foreground",
        )}
      >
        {roleLabel(message.role)}
      </div>
      <div
        className={cn(
          "flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm",
          isUser
            ? "border-border bg-muted/50"
            : "border-transparent bg-transparent",
        )}
      >
        {message.blocks.map((block, i) => (
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const countRef = useRef(messages.length);
  // Scroll anchoring when older messages are prepended.
  const anchorRef = useRef<{ height: number; top: number } | null>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW,
    getItemKey: (i) => messages[i]?.id ?? i,
    overscan: 6,
  });

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

  // Prepending older messages would otherwise yank the viewport to a different
  // part of the conversation.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = anchorRef.current;
    if (!el || !anchor) return;
    if (messages.length > countRef.current) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      anchorRef.current = null;
    }
  }, [messages.length]);

  useEffect(() => {
    const grew = messages.length > countRef.current;
    countRef.current = messages.length;
    if (grew && atBottom && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    }
  }, [messages.length, atBottom, virtualizer]);

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
              <Row message={messages[item.index]} />
            </div>
          ))}
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={() =>
            virtualizer.scrollToIndex(messages.length - 1, { align: "end" })
          }
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1.5 text-xs shadow-lg"
        >
          jump to latest
        </button>
      )}
    </div>
  );
}
