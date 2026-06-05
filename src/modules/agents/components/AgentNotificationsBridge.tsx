import type { Tab } from "@/modules/tabs";
import { hasLeaf, leafIdForPty } from "@/modules/terminal";
import { listen } from "@tauri-apps/api/event";
import { uiLog } from "@/lib/uiLog";
import { useEffect, useRef } from "react";
import { useSessionTabStore } from "@/modules/ai-history/lib/sessionTabStore";
import { maybeTriggerManagedReview } from "../lib/review";
import { routeAgentNotification } from "../lib/route";
import type { AgentSession, AgentSignal } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useAgentStore } from "../store/agentStore";
import { useManagedAgentsStore } from "../store/managedAgentsStore";

type Activate = (tabId: number, leafId: number) => void;
type BindSession = (tabId: number, leafId: number, sessionId: string) => void;
type Ctx = {
  tabs: Tab[];
  activeId: number;
  focused: boolean;
  onActivate: Activate;
  onBindSession: BindSession;
};

function tabInfo(
  tabs: Tab[],
  leafId: number,
): { tabId: number; title: string } | null {
  for (const t of tabs) {
    if (t.kind === "terminal" && hasLeaf(t.paneTree, leafId)) {
      return { tabId: t.id, title: t.title };
    }
  }
  return null;
}

function route(
  session: AgentSession,
  kind: "attention" | "finished",
  ctx: Ctx,
): void {
  const info = tabInfo(ctx.tabs, session.leafId);
  const heading =
    kind === "attention"
      ? `${session.agent} needs your input`
      : `${session.agent} finished`;

  routeAgentNotification({
    source: "terminal",
    agent: session.agent,
    kind,
    title: heading,
    body: info?.title,
    focused: ctx.focused,
    visible: ctx.activeId === session.tabId,
    // Stop fires every turn, so finished only updates the bell; attention toasts.
    allowToast: kind === "attention",
    tabId: session.tabId,
    leafId: session.leafId,
    onActivate: () => ctx.onActivate(session.tabId, session.leafId),
  });
}

// Lifecycle breadcrumbs to terax.log (disk). Only low-frequency events
// (started / session / exited) are logged — working/attention/finished fire
// every turn and would spam the log.
function agentLog(message: string): void {
  uiLog("info", message);
}

function handleSignal(sig: AgentSignal, ctx: Ctx): void {
  const leafId = leafIdForPty(sig.id);
  console.debug("[agent] recv", sig, "→ leafId", leafId);
  if (leafId === null) {
    console.debug("[agent] no leaf bound to pty", sig.id, "— signal dropped");
    return;
  }
  const store = useAgentStore.getState();

  // If the event lands on the terminal the user is already looking at, mark it
  // seen immediately so its dot never appears — no need to switch away and back.
  const ackIfActive = () => {
    const owner = tabInfo(ctx.tabs, leafId);
    if (owner && owner.tabId === ctx.activeId) store.acknowledge(leafId);
  };

  switch (sig.kind) {
    case "started": {
      const info = tabInfo(ctx.tabs, leafId);
      if (!info) {
        console.debug("[agent] started: no tab owns leaf", leafId, "— dropped");
        return;
      }
      console.debug("[agent] start session leaf", leafId, "tab", info.tabId, "agent", sig.agent);
      agentLog(
        `agent started: ${sig.agent ?? "agent"} (leaf ${leafId}, tab ${info.tabId}, pty ${sig.id})`,
      );
      store.start(leafId, info.tabId, sig.agent ?? "agent");
      ackIfActive();
      return;
    }
    case "working":
      if (!store.sessions[leafId]) {
        console.debug("[agent] working: no session for leaf", leafId, "(missed start)");
      }
      store.setStatus(leafId, "working");
      ackIfActive();
      return;
    case "attention": {
      store.setStatus(leafId, "waiting");
      const session = store.sessions[leafId];
      if (session) route(session, "attention", ctx);
      ackIfActive();
      return;
    }
    case "finished": {
      // Stop hook fires at the end of every response turn — show "Completed".
      // The next prompt flips it back to "working" via the working signal.
      store.setStatus(leafId, "completed");
      const session = store.sessions[leafId];
      if (session) route(session, "finished", ctx);
      maybeTriggerManagedReview(leafId);
      ackIfActive();
      return;
    }
    case "exited":
      agentLog(`agent exited (leaf ${leafId}, pty ${sig.id})`);
      store.finish(leafId);
      useManagedAgentsStore.getState().remove(leafId);
      return;
    case "session": {
      if (!sig.session) return;
      const info = tabInfo(ctx.tabs, leafId);
      if (!info) {
        console.debug("[agent] session: no tab owns leaf", leafId, "— dropped");
        return;
      }
      console.debug("[agent] link session", sig.session, "→ tab", info.tabId);
      agentLog(
        `linked Claude session ${sig.session} -> tab ${info.tabId} (leaf ${leafId})`,
      );
      useSessionTabStore.getState().linkSession(sig.session, info.tabId);
      // Register the leaf + persist the exact id on the tab, auto-flag it as a
      // Claude session (so manual launches survive restart), and resolve its
      // title. Passing leafId lets App skip the restore-resume for this live
      // leaf, preventing a duplicate `claude --resume` write.
      ctx.onBindSession(info.tabId, leafId, sig.session);
      return;
    }
  }
}

export function AgentNotificationsBridge({
  tabs,
  activeId,
  onActivate,
  onBindSession,
}: {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
  onBindSession: BindSession;
}) {
  const focused = useWindowFocus();
  const ctxRef = useRef<Ctx>({ tabs, activeId, focused, onActivate, onBindSession });
  ctxRef.current = { tabs, activeId, focused, onActivate, onBindSession };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentSignal>("terax:agent-signal", (e) =>
      handleSignal(e.payload, ctxRef.current),
    )
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return null;
}
