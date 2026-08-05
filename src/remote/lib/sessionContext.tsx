import { createContext, useContext, useMemo, type ReactNode } from "react";

interface SessionInfo {
  /// Composite session id (`agent:<id>`), needed to address per-block reads.
  id: string | null;
  cwd: string | null;
}

/// Identity of the session currently open in the transcript pane. Threaded
/// through context rather than as props because it's needed several layers
/// down (`ToolCard`, `MessageBlock`) — to turn absolute tool paths into paths
/// relative to the project root, and to fetch the remainder of a block the
/// page had to clamp.
const SessionContext = createContext<SessionInfo>({ id: null, cwd: null });

export function SessionProvider({
  id,
  cwd,
  children,
}: {
  id: string | null;
  cwd: string | null;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ id, cwd }), [id, cwd]);
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSessionCwd(): string | null {
  return useContext(SessionContext).cwd;
}

export function useSessionId(): string | null {
  return useContext(SessionContext).id;
}
