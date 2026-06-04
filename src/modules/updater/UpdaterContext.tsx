import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useUpdater, type UpdaterStatus } from "./useUpdater";

interface UpdaterCtx {
  status: UpdaterStatus;
  /** True once an update has been found — stays true even after dismiss. */
  hasUpdate: boolean;
  check: (opts?: { manual?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

const Ctx = createContext<UpdaterCtx | null>(null);

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const { status, check, install, dismiss } = useUpdater({ autoCheck: true });
  const [hasUpdate, setHasUpdate] = useState(false);

  useEffect(() => {
    if (status.kind === "available" || status.kind === "manual-available") {
      setHasUpdate(true);
    }
  }, [status.kind]);

  return (
    <Ctx.Provider value={{ status, hasUpdate, check, install, dismiss }}>
      {children}
    </Ctx.Provider>
  );
}

export function useUpdaterContext(): UpdaterCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useUpdaterContext must be inside UpdaterProvider");
  return ctx;
}
