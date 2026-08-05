import type { Block, Message } from "@/remote/lib/types";

/// Where a block's full payload lives on the server: the owning message's line
/// cursor plus the block's index within that message. A page carries only the
/// first `MAX_BLOCK_BYTES` of each block, so anything clamped is read back by
/// this address rather than by re-fetching the message.
export interface BlockAddress {
  line: number;
  index: number;
}

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
  inputFullBytes: number;
  inputAt: BlockAddress;
  output: string | null;
  isError: boolean;
  outputTruncated: boolean;
  outputFullBytes: number;
  /// Null while the result hasn't arrived — there is nothing to address yet.
  /// Note this is a *different* message than `inputAt`: the two halves of a
  /// tool row live in separate records.
  outputAt: BlockAddress | null;
  /// True while the matching result hasn't arrived yet (call is mid-flight).
  pending: boolean;
}

export type RenderBlock =
  | (Extract<Block, { kind: "text" }> & { at: BlockAddress })
  | (Extract<Block, { kind: "thinking" }> & { at: BlockAddress })
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
    {
      output: string;
      isError: boolean;
      truncated: boolean;
      fullBytes: number;
      at: BlockAddress;
    }
  >();
  for (const m of messages) {
    m.blocks.forEach((b, index) => {
      if (b.kind === "toolResult") {
        results.set(b.id, {
          output: b.output,
          isError: b.isError,
          truncated: b.truncated,
          fullBytes: b.fullBytes,
          at: { line: m.line, index },
        });
      }
    });
  }

  const rows: Row[] = [];
  for (const m of messages) {
    const blocks: RenderBlock[] = [];
    m.blocks.forEach((b, index) => {
      if (b.kind === "toolResult") return;
      if (b.kind === "toolCall") {
        const result = results.get(b.id);
        blocks.push({
          kind: "tool",
          id: b.id,
          name: b.name,
          input: b.input,
          inputTruncated: b.truncated,
          inputFullBytes: b.fullBytes,
          inputAt: { line: m.line, index },
          output: result?.output ?? null,
          isError: result?.isError ?? false,
          outputTruncated: result?.truncated ?? false,
          outputFullBytes: result?.fullBytes ?? 0,
          outputAt: result?.at ?? null,
          pending: !result,
        });
        return;
      }
      if (b.kind === "image") {
        blocks.push(b);
        return;
      }
      blocks.push({ ...b, at: { line: m.line, index } });
    });
    if (blocks.length === 0) continue;
    rows.push({ id: m.id, role: m.role, timestamp: m.timestamp, blocks });
  }
  return rows;
}
