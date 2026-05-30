import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("terax-tabs.json", { defaults: {}, autoSave: 200 });

export type PersistedTab = {
  kind: "terminal" | "editor" | "preview" | "markdown";
  id: number;
  title: string;
  cwd?: string;
  path?: string;
  url?: string;
  pinned?: boolean;
  color?: string;
};

export type PersistedSession = {
  tabs: PersistedTab[];
  activeId: number;
};

export async function saveTabSession(s: PersistedSession): Promise<void> {
  await store.set("session", s);
}

export async function loadTabSession(): Promise<PersistedSession | null> {
  try {
    const entries = await store.entries();
    for (const [k, v] of entries) {
      if (k === "session") return v as PersistedSession;
    }
  } catch {
    // store not yet created or corrupt — return null for fresh start
  }
  return null;
}
