import { useCallback, useEffect, useRef, useState } from "react";
import { fetchPage } from "@/remote/lib/api";
import type { Message } from "@/remote/lib/types";

const PAGE = 50;

export interface TranscriptState {
  messages: Message[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  error: string | null;
  /// Set once the first page lands; the live stream resumes from here.
  resume: { offset: number; line: number } | null;
}

const EMPTY: TranscriptState = {
  messages: [],
  loading: false,
  loadingOlder: false,
  hasMore: false,
  error: null,
  resume: null,
};

/// Loads one session lazily: the newest page on open, older pages only when
/// asked, and live appends merged in by id. Nothing is fetched for sessions the
/// user never opens.
export function useTranscript(sessionId: string | null) {
  const [state, setState] = useState<TranscriptState>(EMPTY);
  // Guards against a slow response for a session the user already left.
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    activeRef.current = sessionId;
    if (!sessionId) {
      setState(EMPTY);
      return;
    }
    setState({ ...EMPTY, loading: true });
    let cancelled = false;

    fetchPage(sessionId, { limit: PAGE })
      .then((page) => {
        if (cancelled || activeRef.current !== sessionId) return;
        setState({
          messages: page.messages,
          loading: false,
          loadingOlder: false,
          hasMore: page.hasMore,
          error: null,
          resume: { offset: page.byteLen, line: page.totalLines },
        });
      })
      .catch((e: unknown) => {
        if (cancelled || activeRef.current !== sessionId) return;
        setState({
          ...EMPTY,
          error: e instanceof Error ? e.message : "failed to load",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const loadOlder = useCallback(() => {
    const id = activeRef.current;
    if (!id) return;
    setState((prev) => {
      if (prev.loadingOlder || !prev.hasMore || prev.messages.length === 0) {
        return prev;
      }
      const before = prev.messages[0].line;
      void fetchPage(id, { before, limit: PAGE })
        .then((page) => {
          if (activeRef.current !== id) return;
          setState((cur) => {
            const known = new Set(cur.messages.map((m) => m.id));
            const older = page.messages.filter((m) => !known.has(m.id));
            return {
              ...cur,
              messages: [...older, ...cur.messages],
              hasMore: page.hasMore,
              loadingOlder: false,
            };
          });
        })
        .catch(() => {
          if (activeRef.current !== id) return;
          setState((cur) => ({ ...cur, loadingOlder: false }));
        });
      return { ...prev, loadingOlder: true };
    });
  }, []);

  /// Live appends. Deduped by id because an SSE reconnect replays from the
  /// offset the connection was opened with.
  const append = useCallback((incoming: Message[]) => {
    setState((cur) => {
      const known = new Set(cur.messages.map((m) => m.id));
      const fresh = incoming.filter((m) => !known.has(m.id));
      if (fresh.length === 0) return cur;
      return { ...cur, messages: [...cur.messages, ...fresh] };
    });
  }, []);

  return { ...state, loadOlder, append };
}
