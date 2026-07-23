import type { Page, ProjectMeta } from "@/remote/lib/types";

/// The token arrives in the URL so a QR code can carry it. Kept in the address
/// bar deliberately: a refresh has to keep working without a re-scan.
export function getToken(): string {
  return new URLSearchParams(window.location.search).get("t") ?? "";
}

export class AuthError extends Error {}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (res.status === 401) throw new AuthError("unauthorized");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function fetchIndex(): Promise<ProjectMeta[]> {
  return get<ProjectMeta[]>("/api/sessions");
}

export function fetchPage(
  id: string,
  opts: { before?: number; limit?: number } = {},
): Promise<Page> {
  const params = new URLSearchParams();
  if (opts.before !== undefined) params.set("before", String(opts.before));
  params.set("limit", String(opts.limit ?? 50));
  return get<Page>(`/api/sessions/${encodeURIComponent(id)}?${params}`);
}

/// EventSource cannot send headers, so the stream authenticates via the query
/// string. Resume position is supplied by the caller so the server holds no
/// per-connection state.
export function streamUrl(opts: {
  session?: string;
  offset?: number;
  line?: number;
}): string {
  const params = new URLSearchParams({ t: getToken() });
  if (opts.session) params.set("session", opts.session);
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.line !== undefined) params.set("line", String(opts.line));
  return `/events?${params}`;
}
