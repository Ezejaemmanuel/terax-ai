import { useEffect, useRef, useState } from "react";
import { streamUrl } from "@/remote/lib/api";
import type { AgentStatus, Message, StatusEvent } from "@/remote/lib/types";

/// The detector reports the process name; the index keys sessions by agent id.
function agentId(name: string | null): string | null {
  if (!name) return null;
  return name === "cursor-agent" ? "cursor" : name;
}

export interface StreamOptions {
  /// Composite session id (`agent:<id>`), or null when nothing is open.
  session: string | null;
  /// Byte offset and line the client has already consumed. Undefined until the
  /// first page has loaded, which is when the stream should connect.
  resume: { offset: number; line: number } | null;
  onAppend: (messages: Message[]) => void;
  onIndexChanged: () => void;
}

/// One SSE connection carries everything: status for the sidebar, and appends
/// for the session currently open. An idle sidebar therefore costs status
/// events alone.
export function useStream({
  session,
  resume,
  onAppend,
  onIndexChanged,
}: StreamOptions) {
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [connected, setConnected] = useState(false);
  // Kept in refs so a changing callback identity does not tear down the stream.
  const appendRef = useRef(onAppend);
  const indexRef = useRef(onIndexChanged);
  appendRef.current = onAppend;
  indexRef.current = onIndexChanged;

  // pty id -> what is running in it, accumulated because only `started`
  // carries the agent name and only the hook marker carries the session id.
  const ptyRef = useRef(new Map<number, { agent?: string; session?: string }>());

  const offset = resume?.offset;
  const line = resume?.line;

  useEffect(() => {
    // Wait for the first page so the stream resumes exactly where it ended.
    if (session && offset === undefined) return;

    const es = new EventSource(
      streamUrl({
        session: session ?? undefined,
        offset,
        line,
      }),
    );

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.addEventListener("append", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          messages: Message[];
        };
        if (data.messages?.length) appendRef.current(data.messages);
      } catch {
        // A malformed frame must not kill the stream.
      }
    });

    es.addEventListener("index", () => indexRef.current());

    es.addEventListener("status", (e) => {
      try {
        const s = JSON.parse((e as MessageEvent).data) as StatusEvent;
        const known = ptyRef.current.get(s.ptyId) ?? {};
        const agent = agentId(s.agent) ?? known.agent;
        const sid = s.session ?? known.session;
        ptyRef.current.set(s.ptyId, { agent, session: sid });

        if (s.kind === "session") return;
        if (s.kind === "exited") {
          ptyRef.current.delete(s.ptyId);
          // Drop the entry entirely rather than parking it on "exited": the
          // terminal sidebar treats presence in this map as "open right now",
          // so a closed terminal must disappear from it, not just fade its dot.
          if (agent && sid) {
            setStatuses((prev) => {
              const key = `${agent}:${sid}`;
              if (!(key in prev)) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }
          return;
        }
        if (!agent || !sid) return;
        setStatuses((prev) => ({
          ...prev,
          [`${agent}:${sid}`]: s.kind as AgentStatus,
        }));
      } catch {
        // Ignore malformed frames.
      }
    });

    return () => {
      es.close();
      setConnected(false);
    };
    // Only the primitive resume values are dependencies: the stream reconnects
    // on session change, not on every append.
  }, [session, offset, line]);

  return { statuses, connected };
}
