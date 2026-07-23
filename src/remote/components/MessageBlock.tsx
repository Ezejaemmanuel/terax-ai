import { memo, useState } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";
import type { Block } from "@/remote/lib/types";

function Truncated() {
  return (
    <div className="mt-1 text-[11px] text-muted-foreground/70">
      truncated for transport
    </div>
  );
}

/// Long payloads stay closed by default. On a phone an expanded 16 KB tool
/// result would bury the conversation.
function Collapsible({
  label,
  tone,
  body,
  truncated,
  defaultOpen,
}: {
  label: string;
  tone: "call" | "result" | "error";
  body: string;
  truncated: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={cn(
        "rounded-md border text-xs",
        tone === "error"
          ? "border-destructive/40 bg-destructive/5"
          : "border-border bg-muted/40",
      )}
    >
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
        <div className="overflow-x-auto border-t border-border/60 px-2.5 py-2">
          <pre className="whitespace-pre font-mono text-[11px] leading-relaxed">
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
  block: Block;
}) {
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
          tone="call"
          body={block.text}
          truncated={block.truncated}
          defaultOpen={false}
        />
      );

    case "toolCall":
      return (
        <Collapsible
          label={`${block.name} · ${firstLine(block.input, 56)}`}
          tone="call"
          body={block.input}
          truncated={block.truncated}
          defaultOpen={false}
        />
      );

    case "toolResult":
      return (
        <Collapsible
          label={
            block.isError
              ? `error · ${firstLine(block.output, 56)}`
              : `result · ${firstLine(block.output, 56)}`
          }
          tone={block.isError ? "error" : "result"}
          body={block.output}
          truncated={block.truncated}
          defaultOpen={false}
        />
      );

    case "image":
      return (
        <div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
          {block.alt}
        </div>
      );
  }
});
