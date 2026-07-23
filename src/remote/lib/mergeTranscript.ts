import type { Block, Message } from "@/remote/lib/types";

/// A `tool_use` merged with its matching `tool_result` (joined by id). Claude
/// Code's transport writes the call under an `assistant` record and the
/// result under a later `user` record; rendering them separately makes the
/// whole transcript look like a wall of "user" turns even though the human
/// typed almost none of it.
export interface ToolRowBlock {
  kind: "tool";
  id: string;
  name: string;
  input: string;
  inputTruncated: boolean;
  output: string | null;
  isError: boolean;
  outputTruncated: boolean;
  /// True while the matching result hasn't arrived yet (call is mid-flight).
  pending: boolean;
}

export type RenderBlock =
  | Extract<Block, { kind: "text" }>
  | Extract<Block, { kind: "thinking" }>
  | Extract<Block, { kind: "image" }>
  | ToolRowBlock;

export interface Row {
  id: string;
  role: Message["role"];
  timestamp: string;
  blocks: RenderBlock[];
}

/// Groups the flat message list into render rows, folding every `toolResult`
/// block into the `toolCall` block it answers. A message that carried nothing
/// but a tool result (the common case for Claude Code) disappears entirely
/// rather than rendering as an empty "user" turn.
export function buildRows(messages: Message[]): Row[] {
  const results = new Map<
    string,
    { output: string; isError: boolean; truncated: boolean }
  >();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === "toolResult") {
        results.set(b.id, {
          output: b.output,
          isError: b.isError,
          truncated: b.truncated,
        });
      }
    }
  }

  const rows: Row[] = [];
  for (const m of messages) {
    const blocks: RenderBlock[] = [];
    for (const b of m.blocks) {
      if (b.kind === "toolResult") continue;
      if (b.kind === "toolCall") {
        const result = results.get(b.id);
        blocks.push({
          kind: "tool",
          id: b.id,
          name: b.name,
          input: b.input,
          inputTruncated: b.truncated,
          output: result?.output ?? null,
          isError: result?.isError ?? false,
          outputTruncated: result?.truncated ?? false,
          pending: !result,
        });
        continue;
      }
      blocks.push(b);
    }
    if (blocks.length === 0) continue;
    rows.push({ id: m.id, role: m.role, timestamp: m.timestamp, blocks });
  }
  return rows;
}
