import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { requestOpenFile } from "@/lib/openFileRequests";
import { useActiveFolderStore } from "@/modules/terminals/activeFolderStore";
import type { LspDiagnostic } from "@/modules/ai/lib/native";
import { normalizeRoot, useLspStore } from "./store";

function baseName(path: string): string {
  const parts = normalizeRoot(path).split("/");
  return parts[parts.length - 1] ?? path;
}

function relativeTo(root: string, path: string): string {
  const normalizedRoot = normalizeRoot(root);
  const normalizedPath = normalizeRoot(path);
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())
    ? normalizedPath.slice(prefix.length)
    : normalizedPath;
}

const SEVERITY_CLASS: Record<number, string> = {
  1: "text-destructive",
  2: "text-amber-400",
};

function DiagnosticRow({
  path,
  diagnostic,
}: {
  path: string;
  diagnostic: LspDiagnostic;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        requestOpenFile({
          path,
          line: diagnostic.startLine + 1,
          column: diagnostic.startCharacter + 1,
        })
      }
      className="flex w-full items-start gap-1.5 rounded px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
    >
      <span
        className={cn(
          "mt-[2px] shrink-0 text-[9px] font-semibold",
          SEVERITY_CLASS[diagnostic.severity] ?? "text-muted-foreground",
        )}
      >
        ●
      </span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-3">{diagnostic.message}</span>
        <span className="text-muted-foreground/60">
          {" "}
          [{diagnostic.startLine + 1}:{diagnostic.startCharacter + 1}]
          {diagnostic.code ? ` ts(${diagnostic.code})` : ""}
        </span>
      </span>
    </button>
  );
}

function ProjectProblems({ root, name }: { root: string; name: string }) {
  const files = useLspStore((s) => s.problems[root]);
  const status = useLspStore((s) => s.status[root]);
  const checking = useLspStore((s) => s.checking[root] ?? false);
  const checkError = useLspStore((s) => s.checkError[root]);
  const checkProject = useLspStore((s) => s.checkProject);

  const sorted = useMemo(
    () =>
      [...(files ?? [])].sort((a, b) =>
        relativeTo(root, a.path).localeCompare(relativeTo(root, b.path)),
      ),
    [files, root],
  );
  const total = sorted.reduce((sum, file) => sum + file.diagnostics.length, 0);

  return (
    <div className="border-b border-border/40 pb-1">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          {name}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {status?.state === "failed" ? "failed" : total > 0 ? total : "clean"}
        </span>
        <button
          type="button"
          disabled={checking}
          onClick={() => void checkProject(root)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
        >
          {checking ? "Checking…" : "Check"}
        </button>
      </div>

      {/* The reason a project has no diagnostics is usually a server that never
          started, so it is stated in full rather than hidden in a tooltip. */}
      {status?.state === "failed" && status.error && (
        <div className="mx-2 mb-1 select-text rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] leading-relaxed text-destructive">
          {status.error}
        </div>
      )}
      {checkError && (
        <div className="mx-2 mb-1 select-text rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] leading-relaxed text-destructive">
          {checkError}
        </div>
      )}
      {status?.state === "ready" && status.exe && (
        <div
          className="truncate px-2 pb-1 text-[10px] text-muted-foreground/50"
          title={status.exe}
        >
          {status.exe}
        </div>
      )}

      {sorted.map((file) => (
        <div key={file.path} className="pb-1">
          <div
            className="truncate px-2 py-0.5 text-[10px] text-muted-foreground/70"
            title={file.path}
          >
            {baseName(file.path)}
            <span className="text-muted-foreground/40"> {relativeTo(root, file.path)}</span>
          </div>
          {file.diagnostics.map((diagnostic, index) => (
            <DiagnosticRow
              key={`${diagnostic.startLine}:${diagnostic.startCharacter}:${index}`}
              path={file.path}
              diagnostic={diagnostic}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * TypeScript problems, per project. Lists only projects whose server the user
 * turned on: with none enabled this view holds nothing and costs nothing.
 */
export function ProblemsPanel() {
  const folders = useActiveFolderStore((s) => s.folders);
  const enabled = useLspStore((s) => s.enabled);

  const projects = useMemo(
    () =>
      folders
        .map((folder) => ({ root: normalizeRoot(folder.cwd), name: folder.name }))
        .filter((project) => (enabled[project.root] ?? "off") !== "off"),
    [folders, enabled],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/50 px-2 py-1.5 text-[11px] font-medium text-foreground">
        Problems
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {projects.length === 0 ? (
          <div className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
            No project has TypeScript enabled. Turn it on with the TS button next
            to a folder in the strip above.
          </div>
        ) : (
          projects.map((project) => (
            <ProjectProblems
              key={project.root}
              root={project.root}
              name={project.name}
            />
          ))
        )}
      </div>
    </div>
  );
}
