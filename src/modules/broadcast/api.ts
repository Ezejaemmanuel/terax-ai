import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface BroadcastInfo {
  url: string;
  token: string;
  port: number;
}

export interface BroadcastConfig {
  port?: number;
  ntfy: { enabled: boolean; server: string; topic: string };
}

export function broadcastStart(config: BroadcastConfig): Promise<BroadcastInfo> {
  return invoke<BroadcastInfo>("broadcast_start", { config });
}

export function broadcastStop(): Promise<void> {
  return invoke("broadcast_stop");
}

export function broadcastStatus(): Promise<BroadcastInfo | null> {
  return invoke<BroadcastInfo | null>("broadcast_status");
}

// The toggle lives in the settings webview but the status indicator lives in
// the main window, and Tauri state changes do not cross webviews on their own.
const CHANGED_EVENT = "terax://broadcast-changed";

export function emitBroadcastChanged(info: BroadcastInfo | null): Promise<void> {
  return emit(CHANGED_EVENT, info);
}

export function onBroadcastChanged(
  cb: (info: BroadcastInfo | null) => void,
): Promise<UnlistenFn> {
  return listen<BroadcastInfo | null>(CHANGED_EVENT, (e) => cb(e.payload));
}
