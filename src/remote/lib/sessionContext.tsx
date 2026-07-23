import { createContext, useContext, type ReactNode } from "react";

/// The cwd of the session currently open in the transcript pane. Threaded
/// through context rather than as a prop because it's needed several layers
/// down (`ToolCard`) to turn absolute tool paths into paths relative to the
/// project root.
const SessionCwdContext = createContext<string | null>(null);

export function SessionCwdProvider({
  cwd,
  children,
}: {
  cwd: string | null;
  children: ReactNode;
}) {
  return (
    <SessionCwdContext.Provider value={cwd}>
      {children}
    </SessionCwdContext.Provider>
  );
}

export function useSessionCwd(): string | null {
  return useContext(SessionCwdContext);
}
