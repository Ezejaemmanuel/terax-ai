import { describe, expect, it } from "vitest";
import { buildRows } from "@/remote/lib/mergeTranscript";
import type { Message } from "@/remote/lib/types";

function msg(id: string, role: Message["role"], blocks: Message["blocks"]): Message {
  return { id, role, timestamp: "t", line: 0, blocks };
}

describe("buildRows", () => {
  it("folds a tool_result into its tool_use and drops the carrier message", () => {
    const messages: Message[] = [
      msg("a1", "assistant", [
        { kind: "toolCall", id: "tu1", name: "Read", input: '{"file_path":"a.rs"}', truncated: false },
      ]),
      msg("u1", "user", [
        { kind: "toolResult", id: "tu1", output: "file body", isError: false, truncated: false },
      ]),
    ];

    const rows = buildRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("a1");
    expect(rows[0].blocks).toEqual([
      {
        kind: "tool",
        id: "tu1",
        name: "Read",
        input: '{"file_path":"a.rs"}',
        inputTruncated: false,
        output: "file body",
        isError: false,
        outputTruncated: false,
        pending: false,
      },
    ]);
  });

  it("marks a tool call pending when no result has arrived yet", () => {
    const messages: Message[] = [
      msg("a1", "assistant", [
        { kind: "toolCall", id: "tu1", name: "Bash", input: '{"command":"ls"}', truncated: false },
      ]),
    ];

    const rows = buildRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocks[0]).toMatchObject({ kind: "tool", pending: true, output: null });
  });

  it("keeps a message that mixes real text with a tool result", () => {
    const messages: Message[] = [
      msg("u1", "user", [
        { kind: "text", text: "here's the output", truncated: false },
        { kind: "toolResult", id: "tu1", output: "done", isError: false, truncated: false },
      ]),
    ];

    const rows = buildRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocks).toEqual([
      { kind: "text", text: "here's the output", truncated: false },
    ]);
  });

  it("propagates the error flag onto the merged tool row", () => {
    const messages: Message[] = [
      msg("a1", "assistant", [
        { kind: "toolCall", id: "tu1", name: "Bash", input: "{}", truncated: false },
      ]),
      msg("u1", "user", [
        { kind: "toolResult", id: "tu1", output: "boom", isError: true, truncated: false },
      ]),
    ];

    const rows = buildRows(messages);
    expect(rows[0].blocks[0]).toMatchObject({ isError: true, output: "boom" });
  });
});
