import { useCallback, useEffect, useState } from "react";

const PREFIX = "#/s/";

function read(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith(PREFIX)) return null;
  const id = decodeURIComponent(hash.slice(PREFIX.length));
  return id.length > 0 ? id : null;
}

/// Hash routing rather than a path router: the token lives in the query string,
/// and the hash survives a reload without any server-side route handling.
export function useHashSession() {
  const [session, setSession] = useState<string | null>(read);

  useEffect(() => {
    const onHash = () => setSession(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const open = useCallback((id: string | null) => {
    window.location.hash = id ? `${PREFIX}${encodeURIComponent(id)}` : "";
  }, []);

  return [session, open] as const;
}
