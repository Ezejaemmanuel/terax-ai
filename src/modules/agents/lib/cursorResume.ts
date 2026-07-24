/** On-disk Cursor chat ref from `cursor_list_sessions`. */
export type CursorChatRef = {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  hasConversation: boolean;
};

/**
 * Pick a chat id to resume for a tab that has no bound id yet.
 * Prefers conversations, skips ids already claimed by other tabs, newest first.
 */
export function pickUnboundCursorChat(
  chats: CursorChatRef[],
  excludeIds: ReadonlySet<string>,
): string | null {
  const available = chats.filter((c) => !excludeIds.has(c.id));
  const withConv = available.find((c) => c.hasConversation);
  if (withConv) return withConv.id;
  return available[0]?.id ?? null;
}

/**
 * After a fresh `cursor-agent` launch, find the chat directory that appeared
 * (or was updated) that wasn't in the pre-launch snapshot.
 */
export function pickNewCursorChat(
  beforeIds: ReadonlySet<string>,
  after: CursorChatRef[],
): string | null {
  const created = after.filter((c) => !beforeIds.has(c.id));
  if (created.length === 0) return null;
  // Newest first from the Rust list; prefer one that already has a turn.
  return created.find((c) => c.hasConversation)?.id ?? created[0].id;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
