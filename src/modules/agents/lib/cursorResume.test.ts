import { describe, expect, it } from "vitest";
import {
  pickNewCursorChat,
  pickUnboundCursorChat,
  type CursorChatRef,
} from "./cursorResume";

function chat(
  id: string,
  opts: Partial<CursorChatRef> = {},
): CursorChatRef {
  return {
    id,
    createdAtMs: 1,
    updatedAtMs: 1,
    hasConversation: true,
    ...opts,
  };
}

describe("pickUnboundCursorChat", () => {
  it("skips ids already bound to other tabs and prefers a conversation", () => {
    const chats = [
      chat("newest-empty", { hasConversation: false, updatedAtMs: 30 }),
      chat("mid", { updatedAtMs: 20 }),
      chat("old", { updatedAtMs: 10 }),
    ];
    expect(pickUnboundCursorChat(chats, new Set(["mid"]))).toBe("old");
  });

  it("falls back to an empty chat when nothing else is free", () => {
    const chats = [chat("only", { hasConversation: false })];
    expect(pickUnboundCursorChat(chats, new Set())).toBe("only");
  });

  it("returns null when every chat is already bound", () => {
    const chats = [chat("a"), chat("b")];
    expect(pickUnboundCursorChat(chats, new Set(["a", "b"]))).toBeNull();
  });
});

describe("pickNewCursorChat", () => {
  it("returns the new conversation id that was not in the snapshot", () => {
    const after = [
      chat("new", { updatedAtMs: 2 }),
      chat("old", { updatedAtMs: 1 }),
    ];
    expect(pickNewCursorChat(new Set(["old"]), after)).toBe("new");
  });

  it("prefers a new chat that already has a conversation", () => {
    const after = [
      chat("empty", { hasConversation: false, updatedAtMs: 3 }),
      chat("ready", { updatedAtMs: 2 }),
    ];
    expect(pickNewCursorChat(new Set(), after)).toBe("ready");
  });

  it("returns null when nothing new appeared", () => {
    expect(pickNewCursorChat(new Set(["a"]), [chat("a")])).toBeNull();
  });
});
