import { invoke, Channel } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

// Max chars per pty_write invoke. ConPTY's input pipe silently drops the tail of
// an oversized single write when the child isn't draining fast enough (the
// "pasted text is cut off" bug). Splitting into separate invokes — each flushed
// on the Rust side — gives the child time to read between chunks. Normal
// keystrokes (1-4 chars) never trip this branch, so typing pays nothing.
const PTY_WRITE_CHUNK = 1024;

// Split a write payload into ordered pieces no larger than `chunk`. Small writes
// (the common keystroke case) pass through as a single-element array. Pure so the
// truncation invariant is unit-testable without the Tauri boundary.
export function ptyWriteChunks(
  data: string,
  chunk: number = PTY_WRITE_CHUNK,
): string[] {
  if (data.length <= chunk) return [data];
  const out: string[] = [];
  for (let i = 0; i < data.length; i += chunk) {
    out.push(data.slice(i, i + chunk));
  }
  return out;
}

export type PtySession = {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    onData,
    onExit,
  });

  let closed = false;

  // Serialize writes per PTY through a promise chain: a large paste is split into
  // ordered chunks, and any concurrent write (a keystroke landing mid-paste, an
  // AI-issued command) queues behind it instead of interleaving on the ConPTY
  // input pipe. Rejections are swallowed off the tail so one failed write can't
  // poison the chain, while the caller still sees the real result.
  let writeTail: Promise<void> = Promise.resolve();
  const write = (data: string): Promise<void> => {
    const run = async () => {
      for (const part of ptyWriteChunks(data)) {
        await invoke("pty_write", { id, data: part });
      }
    };
    const result = writeTail.then(run, run);
    writeTail = result.catch(() => {});
    return result;
  };

  return {
    id,
    write,
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("pty_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
