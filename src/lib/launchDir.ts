import { invoke } from "@tauri-apps/api/core";

let cached: string | undefined;

export async function initLaunchDir(): Promise<void> {
  // Only use the explicit CLI-provided directory — do NOT fall back to
  // workspace_current_dir. That fallback made getLaunchDir() always truthy,
  // which caused useTabSession to skip session restore on every normal launch.
  const dir = await invoke<string | null>("get_launch_dir").catch(() => null);
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}
