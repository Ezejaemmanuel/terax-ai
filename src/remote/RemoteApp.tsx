import { useCallback, useMemo, useState } from "react";
import {
  Cancel01Icon,
  ComputerTerminal02Icon,
  Menu01Icon,
  Settings01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { SettingsPanel } from "@/remote/components/SettingsPanel";
import { Sidebar } from "@/remote/components/Sidebar";
import { StatusDot } from "@/remote/components/StatusDot";
import { TerminalPanel } from "@/remote/components/TerminalPanel";
import { Transcript } from "@/remote/components/Transcript";
import { useRemotePrefs } from "@/remote/lib/prefs";
import { useHashSession } from "@/remote/lib/useHashSession";
import { useIndex } from "@/remote/lib/useIndex";
import { useMediaQuery } from "@/remote/lib/useMediaQuery";
import { SessionCwdProvider } from "@/remote/lib/sessionContext";
import { useStream } from "@/remote/lib/useStream";
import { useTranscript } from "@/remote/lib/useTranscript";
import type { AgentId, ProjectMeta, SessionMeta } from "@/remote/lib/types";

type MobilePanel = "sessions" | "terminal" | "menu" | "settings" | null;

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

function IconButton({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border",
        active
          ? "bg-muted text-foreground"
          : "bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function FullPage({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        <IconButton label="Close" onClick={onClose}>
          <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.75} />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function MenuPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex h-full flex-col bg-background p-2">
      <button
        type="button"
        onClick={onOpenSettings}
        className="flex items-center gap-2 rounded-md px-3 py-3 text-left text-[13px] font-medium hover:bg-muted/50"
      >
        <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.75} />
        Settings
      </button>
    </div>
  );
}

export function RemoteApp() {
  const [sessionId, openSession] = useHashSession();
  const { projects, loading, error, unauthorized, reload } = useIndex();
  const [agent, setAgent] = useState<AgentId>("claude");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [desktopSide, setDesktopSide] = useState<"sessions" | "terminal">(
    "sessions",
  );
  const [desktopSettings, setDesktopSettings] = useState(false);
  const desktop = useMediaQuery("(min-width: 768px)");
  const { theme, toggleTheme } = useRemotePrefs();

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
      setMobilePanel(null);
    },
    [openSession],
  );

  const sessionsSidebar = (
    <Sidebar
      projects={projects}
      statuses={statuses}
      activeId={sessionId}
      onSelect={select}
      agent={agent}
      onAgentChange={setAgent}
    />
  );

  const terminalSidebar = (
    <TerminalPanel
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
    <div className="relative flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {desktop && (
        <aside className="flex w-72 shrink-0 flex-col border-r border-border">
          <div className="flex shrink-0 gap-1 border-b border-border p-1.5">
            <button
              type="button"
              onClick={() => setDesktopSide("sessions")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium",
                desktopSide === "sessions"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              <HugeiconsIcon icon={SidebarLeftIcon} size={13} strokeWidth={1.75} />
              Sessions
            </button>
            <button
              type="button"
              onClick={() => setDesktopSide("terminal")}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium",
                desktopSide === "terminal"
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={13}
                strokeWidth={1.75}
              />
              Terminal
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {desktopSide === "sessions" ? sessionsSidebar : terminalSidebar}
          </div>
        </aside>
      )}

      {!desktop && mobilePanel === "sessions" && (
        <FullPage title="Sessions" onClose={() => setMobilePanel(null)}>
          {sessionsSidebar}
        </FullPage>
      )}
      {!desktop && mobilePanel === "terminal" && (
        <FullPage title="Terminal" onClose={() => setMobilePanel(null)}>
          {terminalSidebar}
        </FullPage>
      )}
      {!desktop && mobilePanel === "menu" && (
        <FullPage title="Menu" onClose={() => setMobilePanel(null)}>
          <MenuPanel onOpenSettings={() => setMobilePanel("settings")} />
        </FullPage>
      )}
      {!desktop && mobilePanel === "settings" && (
        <FullPage title="Settings" onClose={() => setMobilePanel(null)}>
          <SettingsPanel />
        </FullPage>
      )}

      {desktop && desktopSettings && (
        <div className="absolute inset-0 z-40 flex justify-end bg-black/20">
          <div className="flex h-full w-full max-w-sm flex-col border-l border-border bg-background shadow-xl">
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <h2 className="flex-1 text-sm font-medium">Settings</h2>
              <IconButton
                label="Close"
                onClick={() => setDesktopSettings(false)}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.75} />
              </IconButton>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SettingsPanel />
            </div>
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2 sm:px-3"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          {!desktop && (
            <>
              <IconButton
                label="Sessions"
                active={mobilePanel === "sessions"}
                onClick={() => setMobilePanel("sessions")}
              >
                <HugeiconsIcon
                  icon={SidebarLeftIcon}
                  size={16}
                  strokeWidth={1.75}
                />
              </IconButton>
              <IconButton
                label="Terminal"
                active={mobilePanel === "terminal"}
                onClick={() => setMobilePanel("terminal")}
              >
                <HugeiconsIcon
                  icon={ComputerTerminal02Icon}
                  size={16}
                  strokeWidth={1.75}
                />
              </IconButton>
            </>
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
              "size-1.5 shrink-0 rounded-full",
              connected ? "bg-git-added" : "bg-muted-foreground/40",
            )}
            title={connected ? "live" : "reconnecting"}
          />
          {desktop ? (
            <>
              <button
                type="button"
                onClick={toggleTheme}
                className="rounded-md border border-border px-2 py-1 text-xs"
              >
                {theme === "dark" ? "Light" : "Dark"}
              </button>
              <IconButton
                label="Settings"
                active={desktopSettings}
                onClick={() => setDesktopSettings(true)}
              >
                <HugeiconsIcon
                  icon={Settings01Icon}
                  size={16}
                  strokeWidth={1.75}
                />
              </IconButton>
            </>
          ) : (
            <IconButton
              label="Menu"
              active={mobilePanel === "menu" || mobilePanel === "settings"}
              onClick={() => setMobilePanel("menu")}
            >
              <HugeiconsIcon icon={Menu01Icon} size={16} strokeWidth={1.75} />
            </IconButton>
          )}
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
              This session has no transcript source yet, so it can be listed
              but not read.
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
              <SessionCwdProvider cwd={current?.cwd ?? null}>
                <Transcript
                  key={sessionId}
                  messages={transcript.messages}
                  hasMore={transcript.hasMore}
                  loadingOlder={transcript.loadingOlder}
                  onLoadOlder={loadOlder}
                />
              </SessionCwdProvider>
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
