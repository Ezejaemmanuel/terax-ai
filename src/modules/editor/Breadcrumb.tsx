import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useMemo } from "react";

type Props = {
  /** Absolute path of the open file. */
  path: string;
  /** Workspace root the trail is shown relative to, when the file is inside it. */
  rootPath?: string | null;
};

// A deep file would otherwise push the filename out of view; the head of the
// trail is the part nobody reads, so that is what collapses.
const MAX_SEGMENTS = 6;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Path segments from the workspace root (or the filesystem root) to the file. */
export function buildTrail(path: string, rootPath?: string | null): string[] {
  const abs = normalize(path);
  const root = rootPath ? normalize(rootPath) : "";
  // Both strings come from the same source (the tab path and the explorer
  // root), so a plain prefix test is enough; a miss just shows the full path.
  const relative = root !== "" && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  return relative.split("/").filter((name) => name !== "");
}

export const Breadcrumb = memo(function Breadcrumb({ path, rootPath }: Props) {
  const segments = useMemo(() => buildTrail(path, rootPath), [path, rootPath]);
  if (segments.length === 0) return null;

  const overflow = segments.length > MAX_SEGMENTS;
  const shown = overflow ? segments.slice(segments.length - MAX_SEGMENTS) : segments;

  return (
    <nav
      aria-label="File path"
      className="flex h-7 shrink-0 select-none items-center gap-0.5 overflow-hidden border-b border-border/60 px-3 text-[11px] text-muted-foreground"
      title={path}
    >
      {overflow && (
        <>
          <span className="shrink-0">…</span>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            className="shrink-0 opacity-50"
          />
        </>
      )}
      {shown.map((label, index) => (
        <span
          key={`${index}-${label}`}
          className="flex min-w-0 items-center gap-0.5"
        >
          {index > 0 && (
            <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            className="shrink-0 opacity-50"
          />
          )}
          <span
            className={
              index === shown.length - 1 ? "truncate text-foreground/80" : "truncate"
            }
          >
            {label}
          </span>
        </span>
      ))}
    </nav>
  );
});
