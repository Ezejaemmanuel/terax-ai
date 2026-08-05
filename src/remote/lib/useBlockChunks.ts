import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchBlockChunk } from "@/remote/lib/api";
import { useSessionId } from "@/remote/lib/sessionContext";
import type { BlockAddress } from "@/remote/lib/mergeTranscript";

/// The server clamps and offsets in bytes; a JS string length is UTF-16 code
/// units. A block whose head ends in emoji or CJK would otherwise resume at the
/// wrong offset and duplicate or skip text.
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface BlockChunks {
  /// The head the page delivered, plus every range fetched since.
  text: string;
  /// Bytes of this block not yet fetched.
  remaining: number;
  /// True once the whole payload has been read (or was never clamped).
  complete: boolean;
  loading: boolean;
  error: string | null;
  /// Fetches the next range. No-op while a fetch is in flight or once complete.
  loadMore: () => void;
}

/// Reads back what the page's per-block cap left behind, one range per call,
/// so a phone can walk a multi-megabyte tool result without ever committing to
/// pulling all of it. Nothing is fetched until `loadMore` is called: an
/// untouched block costs exactly what the page already sent.
export function useBlockChunks(
  head: string,
  fullBytes: number,
  truncated: boolean,
  at: BlockAddress | null,
): BlockChunks {
  const sessionId = useSessionId();
  const [tail, setTail] = useState("");
  const [offset, setOffset] = useState<number | null>(null);
  const [complete, setComplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every reset so a response for a block we've moved off of is
  // dropped instead of appended to the wrong text.
  const runRef = useRef(0);
  // Mirrors `loading` for the in-flight guard: a double click (or StrictMode's
  // double invoke) must not fire the same range twice and append it twice.
  const loadingRef = useRef(false);

  const headBytes = useMemo(() => byteLength(head), [head]);
  const line = at?.line;
  const index = at?.index;

  useEffect(() => {
    runRef.current += 1;
    loadingRef.current = false;
    setTail("");
    setOffset(null);
    setComplete(false);
    setLoading(false);
    setError(null);
  }, [sessionId, line, index, headBytes]);

  const loadMore = useCallback(() => {
    if (!sessionId || line === undefined || index === undefined) return;
    if (loadingRef.current || complete) return;

    const run = runRef.current;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    void fetchBlockChunk(sessionId, line, index, offset ?? headBytes)
      .then((chunk) => {
        if (runRef.current !== run) return;
        loadingRef.current = false;
        setTail((prev) => prev + chunk.text);
        setOffset(chunk.nextOffset);
        setComplete(chunk.eof);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (runRef.current !== run) return;
        loadingRef.current = false;
        setError(e instanceof Error ? e.message : "failed to load the rest");
        setLoading(false);
      });
  }, [sessionId, line, index, offset, headBytes, complete]);

  const read = offset ?? headBytes;
  return {
    text: head + tail,
    remaining: Math.max(fullBytes - read, 0),
    complete: complete || !truncated,
    loading,
    error,
    loadMore,
  };
}

/// Byte counts as a person reads them, for the expand control's label.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
