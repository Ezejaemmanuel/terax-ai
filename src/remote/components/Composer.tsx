import { useEffect, useRef, useState } from "react";
import { SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { postReply, ReplyError } from "@/remote/lib/api";
import type { AgentStatus } from "@/remote/lib/types";

/// Grows with the text up to this, then scrolls. Keeps the transcript visible
/// on a phone even while composing something long.
const MAX_ROWS_PX = 140;

/// Why the composer cannot send right now, phrased for the person holding the
/// phone. `null` means it can.
function blockedReason(status: AgentStatus | undefined): string | null {
  if (!status || status === "exited") {
    return "This session is not open in a terminal right now.";
  }
  return null;
}

export function Composer({
  sessionId,
  status,
  maxLength,
}: {
  sessionId: string;
  status: AgentStatus | undefined;
  maxLength: number;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /// Set when the server refused only because the agent is mid-turn. Holding it
  /// separately is what lets the retry say "queue it" rather than silently
  /// re-sending something the user did not reconsider.
  const [queueable, setQueueable] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Reset when the viewer switches sessions: a half-typed message belongs to
  // the conversation it was written for.
  useEffect(() => {
    setText("");
    setError(null);
    setQueueable(false);
  }, [sessionId]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text]);

  const blocked = blockedReason(status);
  const tooLong = text.length > maxLength;
  const canSend = !sending && !blocked && !tooLong && text.trim().length > 0;

  const send = async (force: boolean) => {
    if (sending || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await postReply(sessionId, text, { force });
      // Cleared only on success, so a rejected message is never lost.
      setText("");
      setQueueable(false);
    } catch (e) {
      if (e instanceof ReplyError) {
        setError(e.message);
        setQueueable(e.busy);
      } else {
        setError(e instanceof Error ? e.message : "could not send");
        setQueueable(false);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="shrink-0 border-t border-border bg-background px-2 py-2 sm:px-3"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      {error && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1">
          <span className="text-[11px] text-destructive">{error}</span>
          {queueable && (
            <button
              type="button"
              onClick={() => void send(true)}
              disabled={sending}
              className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium hover:bg-muted/60"
            >
              Send anyway
            </button>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={!!blocked}
          placeholder={blocked ?? "Reply to this agent…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends only alongside a modifier: on a phone keyboard a bare
            // Enter is how you write a second line, and there is no way to tell
            // the two intents apart from the key alone.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canSend) void send(false);
            }
          }}
          className={cn(
            "min-h-[36px] flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm",
            "placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-60",
            tooLong && "border-destructive focus:ring-destructive",
          )}
        />
        <button
          type="button"
          onClick={() => void send(false)}
          disabled={!canSend}
          aria-label="Send reply"
          title="Send reply"
          className={cn(
            "inline-flex size-9 shrink-0 items-center justify-center rounded-lg",
            canSend
              ? "bg-primary text-primary-foreground hover:opacity-90"
              : "bg-muted text-muted-foreground/50",
          )}
        >
          <HugeiconsIcon icon={SentIcon} size={16} strokeWidth={1.75} />
        </button>
      </div>

      {tooLong && (
        <p className="px-1 pt-1 text-[10.5px] text-destructive">
          {text.length} / {maxLength} characters
        </p>
      )}
    </div>
  );
}
