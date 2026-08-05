import { describe, expect, it } from "vitest";
import { buildRows } from "@/remote/lib/mergeTranscript";
import type { Message } from "@/remote/lib/types";

function msg(
  id: string,
  role: Message["role"],
  blocks: Message["blocks"],
  line = 0,
): Message {
  return { id, role, timestamp: "t", line, blocks };
}

describe("buildRows", () => {
  it("folds a tool_result into its tool_use and drops the carrier message", () => {
    const messages: Message[] = [
      msg("a1", "assistant", [
        {
          kind: "toolCall",
          id: "tu1",
          name: "Read",
          input: '{"file_path":"a.rs"}',
          truncated: false,
          fullBytes: 20,
        },
      ]),
      msg("u1", "user", [
        {
          kind: "toolResult",
          id: "tu1",
          output: "file body",
          isError: false,
          truncated: false,
          fullBytes: 9,
        },
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
        inputFullBytes: 20,
        inputAt: { line: 0, index: 0 },
        output: "file body",
        isError: false,
        outputTruncated: false,
        outputFullBytes: 9,
        outputAt: { line: 0, index: 0 },
        pending: false,
      },
    ]);
  });

  /// The two halves of a tool row live in different records, so each has to
  /// carry its own address for the expand-in-place reads to hit the right one.
  it("addresses the call and the result at their own messages", () => {
    const messages: Message[] = [
      msg(
        "a1",
        "assistant",
        [
          { kind: "text", text: "running it", truncated: false, fullBytes: 10 },
          {
            kind: "toolCall",
            id: "tu1",
            name: "Bash",
            input: "{}",
            truncated: true,
            fullBytes: 90_000,
          },
        ],
        7,
      ),
      msg(
        "u1",
        "user",
        [
          {
            kind: "toolResult",
            id: "tu1",
            output: "head",
            isError: false,
            truncated: true,
            fullBytes: 5_000_000,
          },
        ],
        11,
      ),
    ];

    const rows = buildRows(messages);
    expect(rows[0].blocks[0]).toMatchObject({
      kind: "text",
      at: { line: 7, index: 0 },
    });
    expect(rows[0].blocks[1]).toMatchObject({
      kind: "tool",
      inputAt: { line: 7, index: 1 },
      inputFullBytes: 90_000,
      outputAt: { line: 11, index: 0 },
      outputFullBytes: 5_000_000,
    });
  });

  it("marks a tool call pending when no result has arrived yet", () => {
    const messages: Message[] = [
      msg("a1", "assistant", [
        {
          kind: "toolCall",
          id: "tu1",
          name: "Bash",
          input: '{"command":"ls"}',
          truncated: false,
          fullBytes: 16,
        },
      ]),
    ];

    const rows = buildRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocks[0]).toMatchObject({
      kind: "tool",
      pending: true,
      output: null,
      // Nothing to address until the result record exists.
      outputAt: null,
    });
  });

  it("keeps a message that mixes real text with a tool result", () => {
    const messages: Message[] = [
      msg("u1", "user", [
        { kind: "text", text: "here's the output", truncated: false, fullBytes: 17 },
        {
          kind: "toolResult",
          id: "tu1",
          output: "done",
          isError: false,
          truncated: false,
          fullBytes: 4,
        },
      ]),
    ];

    const rows = buildRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocks).toEqual([
      {
        kind: "text",
        text: "here's the output",
        truncated: false,
        fullBytes: 17,
        at: { line: 0, index: 0 },
      },
    ]);
  });

  it("propagates the error flag onto the merged tool row", () => {
    const messages: Message[] = [
      msg("a1", "assistant", [
        { kind: "toolCall", id: "tu1", name: "Bash", input: "{}", truncated: false, fullBytes: 2 },
      ]),
      msg("u1", "user", [
        {
          kind: "toolResult",
          id: "tu1",
          output: "boom",
          isError: true,
          truncated: false,
          fullBytes: 4,
        },
      ]),
    ];

    const rows = buildRows(messages);
    expect(rows[0].blocks[0]).toMatchObject({ isError: true, output: "boom" });
  });
});
