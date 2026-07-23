import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import { collapseContext, diffLines } from "@/remote/lib/diff";

/// Renders a unified, line-colored diff between two full-text blobs. Kept
/// deliberately plain (no syntax highlighting, no editor widget) so it stays
/// cheap enough for the remote bundle: tool edits are small, and this only
/// ever needs to look like `git diff`, not be one.
export const DiffView = memo(function DiffView({
  oldText,
  newText,
}: {
  oldText: string;
  newText: string;
}) {
  const rows = useMemo(() => collapseContext(diffLines(oldText, newText)), [oldText, newText]);

  return (
    <div className="overflow-hidden rounded border border-border/60 font-mono text-[11px] leading-relaxed">
      {rows.map((row, i) =>
        "count" in row ? (
          <div
            key={i}
            className="select-none bg-muted/30 px-2 py-0.5 text-muted-foreground/60"
          >
            ⋯ {row.count} unchanged line{row.count === 1 ? "" : "s"}
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              "flex whitespace-pre-wrap break-words px-1",
              row.type === "add" && "bg-git-added/15",
              row.type === "del" && "bg-destructive/10",
            )}
          >
            <span
              className={cn(
                "sticky left-0 mr-1.5 inline-block w-3 shrink-0 select-none text-center",
                row.type === "add" && "text-git-added",
                row.type === "del" && "text-destructive",
                row.type === "ctx" && "text-transparent",
              )}
              aria-hidden
            >
              {row.type === "add" ? "+" : row.type === "del" ? "−" : "·"}
            </span>
            <span className="min-w-0 flex-1">{row.text.length === 0 ? "\u00A0" : row.text}</span>
          </div>
        ),
      )}
    </div>
  );
});
