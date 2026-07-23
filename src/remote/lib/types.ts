export type AgentId = "claude" | "codex" | "command-code" | "cursor";

export type Block =
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "thinking"; text: string; truncated: boolean }
  | { kind: "toolCall"; id: string; name: string; input: string; truncated: boolean }
  | {
      kind: "toolResult";
      id: string;
      output: string;
      isError: boolean;
      truncated: boolean;
    }
  | { kind: "image"; alt: string };

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

export interface StatusEvent {
  ptyId: number;
  kind: AgentStatus | "session";
  agent: string | null;
  session: string | null;
}
