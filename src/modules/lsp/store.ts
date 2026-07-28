import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import {
  native,
  type LspDiagnostic,
  type LspFileProblems,
  type LspStatus,
} from "@/modules/ai/lib/native";

const store = new LazyStore("terax-lsp.json", { defaults: {}, autoSave: 200 });
const PERSIST_KEY = "persistentRoots";

/**
 * Two ways to be on, and the difference is the whole point of the feature:
 * `session` dies with the window, `persistent` is remembered. Projects are off
 * by default in both, so a cold start spawns no language server at all.
 */
export type LspEnablement = "off" | "session" | "persistent";

export function normalizeRoot(root: string): string {
  const forward = root.replace(/\\/g, "/");
  return forward.length > 1 ? forward.replace(/\/+$/, "") : forward;
}

type State = {
  /** Root → how it was enabled. Absent means off. */
  enabled: Record<string, LspEnablement>;
  status: Record<string, LspStatus>;
  /** Root → problems by file, from open editors and whole-project checks. */
  problems: Record<string, LspFileProblems[]>;
  /** Root → a whole-project check is running. */
  checking: Record<string, boolean>;
  /** Root → why the last whole-project check failed. */
  checkError: Record<string, string>;
  /** False until the persisted set has been read, so nothing starts twice. */
  hydrated: boolean;
};

type Actions = {
  hydrate: () => Promise<void>;
  enable: (root: string, mode: "session" | "persistent") => Promise<void>;
  disable: (root: string) => Promise<void>;
  /** Stop the server but keep the project's enablement, e.g. the folder closed. */
  stopServer: (root: string) => Promise<void>;
  refreshStatus: (root: string) => Promise<void>;
  setStatus: (status: LspStatus) => void;
  setFileProblems: (root: string, path: string, diagnostics: LspDiagnostic[]) => void;
  checkProject: (root: string) => Promise<void>;
};

async function readPersisted(): Promise<string[]> {
  try {
    const raw = await store.get<string[]>(PERSIST_KEY);
    return Array.isArray(raw) ? raw.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

async function writePersisted(roots: string[]): Promise<void> {
  await store.set(PERSIST_KEY, roots);
  await store.save();
}

export const useLspStore = create<State & Actions>((set, get) => ({
  enabled: {},
  status: {},
  problems: {},
  checking: {},
  checkError: {},
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const roots = await readPersisted();
    if (roots.length > 0) {
      const { attachLspEvents } = await import("./events");
      attachLspEvents();
    }
    set({
      hydrated: true,
      enabled: Object.fromEntries(
        roots.map((root) => [normalizeRoot(root), "persistent" as const]),
      ),
    });
    // Servers for remembered projects start lazily: the first file opened in
    // one brings it up. Starting them all here would undo the point of a
    // feature that is meant to cost nothing until used.
  },

  enable: async (root, mode) => {
    const key = normalizeRoot(root);
    set((s) => ({ enabled: { ...s.enabled, [key]: mode } }));
    const { attachLspEvents } = await import("./events");
    attachLspEvents();

    if (mode === "persistent") {
      const roots = await readPersisted();
      if (!roots.some((r) => normalizeRoot(r) === key)) {
        await writePersisted([...roots, key]);
      }
    }

    try {
      const status = await native.lspStart(key);
      set((s) => ({ status: { ...s.status, [key]: status } }));
    } catch (error) {
      set((s) => ({
        status: {
          ...s.status,
          [key]: {
            root: key,
            state: "failed",
            exe: null,
            error: String(error),
            openDocuments: 0,
          },
        },
      }));
    }
  },

  disable: async (root) => {
    const key = normalizeRoot(root);
    set((s) => {
      const enabled = { ...s.enabled };
      delete enabled[key];
      const status = { ...s.status };
      delete status[key];
      const problems = { ...s.problems };
      delete problems[key];
      return { enabled, status, problems };
    });
    const roots = await readPersisted();
    const remaining = roots.filter((r) => normalizeRoot(r) !== key);
    if (remaining.length !== roots.length) await writePersisted(remaining);
    await native.lspStop(key).catch(() => {});
  },

  stopServer: async (root) => {
    const key = normalizeRoot(root);
    if ((get().enabled[key] ?? "off") === "off") return;
    set((s) => {
      const status = { ...s.status };
      delete status[key];
      const problems = { ...s.problems };
      delete problems[key];
      return { status, problems };
    });
    await native.lspStop(key).catch(() => {});
  },

  refreshStatus: async (root) => {
    const key = normalizeRoot(root);
    const statuses = await native.lspStatuses().catch(() => []);
    const found = statuses.find((s) => normalizeRoot(s.root) === key);
    if (found) set((s) => ({ status: { ...s.status, [key]: found } }));
  },

  setStatus: (status) =>
    set((s) => ({
      status: { ...s.status, [normalizeRoot(status.root)]: status },
    })),

  setFileProblems: (root, path, diagnostics) =>
    set((s) => {
      const key = normalizeRoot(root);
      const file = normalizeRoot(path);
      const existing = s.problems[key] ?? [];
      const rest = existing.filter((entry) => normalizeRoot(entry.path) !== file);
      const next =
        diagnostics.length === 0 ? rest : [...rest, { path: file, diagnostics }];
      // Referential equality matters here: this runs on every keystroke pause,
      // and a new array would re-render the Problems list for nothing.
      if (rest.length === existing.length && diagnostics.length === 0) return s;
      return { problems: { ...s.problems, [key]: next } };
    }),

  checkProject: async (root) => {
    const key = normalizeRoot(root);
    set((s) => ({
      checking: { ...s.checking, [key]: true },
      checkError: { ...s.checkError, [key]: "" },
    }));
    try {
      const files = await native.lspProjectCheck(key);
      set((s) => ({
        problems: {
          ...s.problems,
          [key]: files.map((f) => ({ ...f, path: normalizeRoot(f.path) })),
        },
        checking: { ...s.checking, [key]: false },
      }));
    } catch (error) {
      set((s) => ({
        checking: { ...s.checking, [key]: false },
        checkError: { ...s.checkError, [key]: String(error) },
      }));
    }
  },
}));

/** Called from the editor as diagnostics arrive for one open file. */
export function recordFileProblems(
  root: string,
  path: string,
  diagnostics: LspDiagnostic[],
): void {
  useLspStore.getState().setFileProblems(root, path, diagnostics);
}

export function lspEnablement(root: string): LspEnablement {
  return useLspStore.getState().enabled[normalizeRoot(root)] ?? "off";
}

/**
 * The enabled project a file belongs to, or null. Longest match wins so a
 * nested project takes precedence over its parent. Takes the map rather than
 * reading the store so it can be used as a zustand selector.
 */
export function rootForPathIn(
  enabled: Record<string, LspEnablement>,
  path: string,
): string | null {
  const target = normalizeRoot(path);
  let best: string | null = null;
  for (const root of Object.keys(enabled)) {
    if (target === root || target.startsWith(`${root}/`)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}

export function lspRootForPath(path: string): string | null {
  return rootForPathIn(useLspStore.getState().enabled, path);
}
