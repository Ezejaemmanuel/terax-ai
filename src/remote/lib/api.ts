import type { Page, ProjectMeta, RemoteConfig } from "@/remote/lib/types";

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

export function fetchConfig(): Promise<RemoteConfig> {
  return get<RemoteConfig>("/api/config");
}

/// Raised when the server refuses a reply for a reason worth showing verbatim —
/// the agent is busy, the terminal closed, the text was rejected.
export class ReplyError extends Error {
  /// True when the send would succeed as a queued message if retried with force.
  readonly busy: boolean;

  constructor(message: string, busy: boolean) {
    super(message);
    this.busy = busy;
  }
}

/// Types a message into the terminal running this session.
///
/// Unlike the read paths, the token goes in the header and never in the query
/// string — the server rejects a query-authenticated write outright, so that a
/// leaked link in a browser history cannot be turned into a keystroke by
/// navigation alone.
export async function postReply(
  id: string,
  text: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, force: opts.force ?? false }),
  });
  if (res.ok) return;
  if (res.status === 401) throw new AuthError("unauthorized");

  const body = (await res.json().catch(() => null)) as {
    error?: string;
    busy?: boolean;
  } | null;
  throw new ReplyError(
    body?.error ?? `${res.status} ${res.statusText}`,
    body?.busy ?? false,
  );
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
