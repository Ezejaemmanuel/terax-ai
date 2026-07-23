import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/remote/lib/types";

const TONE: Record<AgentStatus, { color: string; label: string; pulse: boolean }> =
  {
    started: { color: "bg-chart-2", label: "starting", pulse: true },
    working: { color: "bg-chart-2", label: "working", pulse: true },
    attention: { color: "bg-git-modified", label: "needs you", pulse: true },
    finished: { color: "bg-git-added", label: "done", pulse: false },
    exited: { color: "bg-muted-foreground/40", label: "exited", pulse: false },
  };

export function StatusDot({ status }: { status: AgentStatus | undefined }) {
  if (!status) return null;
  const tone = TONE[status];
  return (
    <span className="inline-flex items-center gap-1.5" title={tone.label}>
      <span className="relative flex size-2">
        {tone.pulse && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60",
              tone.color,
            )}
          />
        )}
        <span
          className={cn("relative inline-flex size-2 rounded-full", tone.color)}
        />
      </span>
      <span className="sr-only">{tone.label}</span>
    </span>
  );
}
