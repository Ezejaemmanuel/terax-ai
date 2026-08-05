import { memo, useEffect, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import { useRemotePrefs } from "@/remote/lib/prefs";
import { useBlockChunks } from "@/remote/lib/useBlockChunks";
import type { BlockAddress, RenderBlock } from "@/remote/lib/mergeTranscript";
import { ExpandTail } from "@/remote/components/ExpandTail";
import { ToolCard } from "@/remote/components/ToolCard";

function Collapsible({
  label,
  body,
  footer,
  defaultOpen,
}: {
  label: string;
  body: string;
  footer: ReactNode;
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
          {footer}
        </div>
      )}
    </div>
  );
}

function firstLine(s: string, max = 72) {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function TextBlock({
  text,
  truncated,
  fullBytes,
  at,
}: {
  text: string;
  truncated: boolean;
  fullBytes: number;
  at: BlockAddress;
}) {
  const chunks = useBlockChunks(text, fullBytes, truncated, at);
  return (
    <div className="prose-remote">
      <Streamdown>{chunks.text}</Streamdown>
      <ExpandTail state={chunks} />
    </div>
  );
}

function ThinkingBlock({
  text,
  truncated,
  fullBytes,
  at,
  defaultOpen,
}: {
  text: string;
  truncated: boolean;
  fullBytes: number;
  at: BlockAddress;
  defaultOpen: boolean;
}) {
  const chunks = useBlockChunks(text, fullBytes, truncated, at);
  return (
    <Collapsible
      label={`thinking · ${firstLine(text, 56)}`}
      body={chunks.text}
      footer={<ExpandTail state={chunks} />}
      defaultOpen={defaultOpen}
    />
  );
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
        <TextBlock
          text={block.text}
          truncated={block.truncated}
          fullBytes={block.fullBytes}
          at={block.at}
        />
      );

    case "thinking":
      return (
        <ThinkingBlock
          text={block.text}
          truncated={block.truncated}
          fullBytes={block.fullBytes}
          at={block.at}
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
