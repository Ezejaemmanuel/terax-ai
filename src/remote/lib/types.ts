export type AgentId = "claude" | "codex" | "command-code" | "cursor";

/// `truncated` means the page left part of this block behind to keep the
/// transfer small; `fullBytes` is the payload's true length, and the remainder
/// is fetched by address with `fetchBlockChunk`.
export type Block =
  | { kind: "text"; text: string; truncated: boolean; fullBytes: number }
  | { kind: "thinking"; text: string; truncated: boolean; fullBytes: number }
  | {
      kind: "toolCall";
      id: string;
      name: string;
      input: string;
      truncated: boolean;
      fullBytes: number;
    }
  | {
      kind: "toolResult";
      id: string;
      output: string;
      isError: boolean;
      truncated: boolean;
      fullBytes: number;
    }
  | { kind: "image"; alt: string };

/// One range of a block's full payload.
export interface Chunk {
  text: string;
  /// Byte offset to ask for next; equals `fullBytes` once `eof` is true.
  nextOffset: number;
  fullBytes: number;
  eof: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  timestamp: string;
  line: number;
  blocks: Block[];
}

export interface Page {
  messages: Message[];
  hasMore: boolean;
  oldestLine: number;
  byteLen: number;
  totalLines: number;
}

export interface SessionMeta {
  id: string;
  agent: AgentId;
  title: string;
  cwd: string;
  updatedAt: string;
  readable: boolean;
}

export interface ProjectMeta {
  name: string;
  fullPath: string;
  sessions: SessionMeta[];
}

/// Mirrors the PTY detector's transitions.
export type AgentStatus =
  | "started"
  | "working"
  | "attention"
  | "finished"
  | "exited";

/// What this broadcast permits, fetched once at startup so the viewer can shape
/// itself instead of finding out by having a send rejected.
export interface RemoteConfig {
  reply: {
    enabled: boolean;
    agents: AgentId[];
    maxLength: number;
  };
}

export interface StatusEvent {
  ptyId: number;
  kind: AgentStatus | "session";
  agent: string | null;
  session: string | null;
}
