import { memo, useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import { useRemotePrefs } from "@/remote/lib/prefs";
import type { RenderBlock } from "@/remote/lib/mergeTranscript";
import { ToolCard } from "@/remote/components/ToolCard";

function Truncated() {
  return (
    <div className="mt-1 text-[11px] text-muted-foreground/70">
      truncated for transport
    </div>
  );
}

function Collapsible({
  label,
  body,
  truncated,
  defaultOpen,
}: {
  label: string;
  body: string;
  truncated: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    setOpen(defaultOpen);
  }, [defaultOpen]);

  return (
    <div className="rounded-md border border-border bg-muted/40 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono"
      >
        <span
          className={cn(
            "shrink-0 transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        >
          ▸
        </span>
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <div className="border-t border-border/60 px-2.5 py-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
            {body}
          </pre>
          {truncated && <Truncated />}
        </div>
      )}
    </div>
  );
}

function firstLine(s: string, max = 72) {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export const MessageBlock = memo(function MessageBlock({
  block,
}: {
  block: RenderBlock;
}) {
  const { accordionsOpen } = useRemotePrefs();

  switch (block.kind) {
    case "text":
      return (
        <div className="prose-remote">
          <Streamdown>{block.text}</Streamdown>
          {block.truncated && <Truncated />}
        </div>
      );

    case "thinking":
      return (
        <Collapsible
          label={`thinking · ${firstLine(block.text, 56)}`}
          body={block.text}
          truncated={block.truncated}
          defaultOpen={accordionsOpen}
        />
      );

    case "tool":
      return <ToolCard block={block} defaultOpen={accordionsOpen} />;

    case "image":
      return (
        <div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
          {block.alt}
        </div>
      );
  }
});
