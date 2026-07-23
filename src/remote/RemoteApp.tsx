import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { Sidebar } from "@/remote/components/Sidebar";
import { StatusDot } from "@/remote/components/StatusDot";
import { Transcript } from "@/remote/components/Transcript";
import { useHashSession } from "@/remote/lib/useHashSession";
import { useIndex } from "@/remote/lib/useIndex";
import { useMediaQuery } from "@/remote/lib/useMediaQuery";
import { useStream } from "@/remote/lib/useStream";
import { useTranscript } from "@/remote/lib/useTranscript";
import type { ProjectMeta, SessionMeta } from "@/remote/lib/types";

const THEME_KEY = "terax-remote-theme";

function findSession(
  projects: ProjectMeta[],
  id: string | null,
): SessionMeta | null {
  if (!id) return null;
  for (const project of projects) {
    const hit = project.sessions.find((s) => s.id === id);
    if (hit) return hit;
  }
  return null;
}

function useTheme() {
  const [dark, setDark] = useState(
    () => document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  }, [dark]);
  return [dark, () => setDark((v) => !v)] as const;
}

export function RemoteApp() {
  const [sessionId, openSession] = useHashSession();
  const { projects, loading, error, unauthorized, reload } = useIndex();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dark, toggleTheme] = useTheme();
  const desktop = useMediaQuery("(min-width: 768px)");

  const transcript = useTranscript(sessionId);
  const { append, loadOlder, resume } = transcript;

  const onIndexChanged = useCallback(() => reload(), [reload]);
  const { statuses, connected } = useStream({
    session: sessionId,
    resume,
    onAppend: append,
    onIndexChanged,
  });

  const current = useMemo(
    () => findSession(projects, sessionId),
    [projects, sessionId],
  );

  const select = useCallback(
    (id: string) => {
      openSession(id);
      setSheetOpen(false);
    },
    [openSession],
  );

  const sidebar = (
    <Sidebar
      projects={projects}
      statuses={statuses}
      activeId={sessionId}
      onSelect={select}
    />
  );

  if (unauthorized) {
    return (
      <Centered>
        <h1 className="text-base font-medium">Not authorized</h1>
        <p className="max-w-xs text-sm text-muted-foreground">
          This link is missing or has an outdated token. Re-scan the QR code in
          Terax settings.
        </p>
      </Centered>
    );
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {desktop && (
        <aside className="w-70 shrink-0 border-r border-border">{sidebar}</aside>
      )}

      {!desktop && (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="left" className="w-[85vw] p-0 sm:max-w-sm">
            <SheetTitle className="px-3 pt-3">Sessions</SheetTitle>
            <div className="min-h-0 flex-1">{sidebar}</div>
          </SheetContent>
        </Sheet>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          {!desktop && (
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="rounded-md border border-border px-2 py-1 text-xs"
            >
              Sessions
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {sessionId && <StatusDot status={statuses[sessionId]} />}
              <span className="truncate text-sm font-medium">
                {current?.title ?? "Terax remote"}
              </span>
            </div>
            {current && (
              <div className="truncate text-[11px] text-muted-foreground">
                {current.cwd}
              </div>
            )}
          </div>
          <span
            className={cn(
              "size-1.5 rounded-full",
              connected ? "bg-git-added" : "bg-muted-foreground/40",
            )}
            title={connected ? "live" : "reconnecting"}
          />
          <button
            type="button"
            onClick={toggleTheme}
            className="rounded-md border border-border px-2 py-1 text-xs"
          >
            {dark ? "Light" : "Dark"}
          </button>
        </header>

        {!sessionId && (
          <Centered>
            {loading ? (
              <p className="text-sm text-muted-foreground">loading sessions…</p>
            ) : error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : (
              <p className="max-w-xs text-sm text-muted-foreground">
                Pick a session to read it. Nothing is downloaded until you open
                one.
              </p>
            )}
          </Centered>
        )}

        {sessionId && current && !current.readable && (
          <Centered>
            <p className="max-w-xs text-sm text-muted-foreground">
              Cursor keeps its transcripts in a SQLite database, so this session
              can be listed but not read.
            </p>
          </Centered>
        )}

        {sessionId && (!current || current.readable) && (
          <>
            {transcript.loading && (
              <Centered>
                <p className="text-sm text-muted-foreground">loading…</p>
              </Centered>
            )}
            {transcript.error && (
              <Centered>
                <p className="text-sm text-destructive">{transcript.error}</p>
              </Centered>
            )}
            {!transcript.loading && !transcript.error && (
              <Transcript
                messages={transcript.messages}
                hasMore={transcript.hasMore}
                loadingOlder={transcript.loadingOlder}
                onLoadOlder={loadOlder}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      {children}
    </div>
  );
}
