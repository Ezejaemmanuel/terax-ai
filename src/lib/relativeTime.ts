/**
 * Format a timestamp as a human-readable relative string.
 * Accepts either:
 * - A number (unix milliseconds)
 * - A 20-digit zero-padded unix-ms string (from Terax file mtime encoding)
 * - An ISO 8601 string
 */
export function relativeTime(ts: number | string): string {
  let ms: number;
  if (typeof ts === "number") {
    ms = ts;
  } else if (/^\d{20}$/.test(ts)) {
    ms = parseInt(ts, 10);
  } else {
    ms = new Date(ts).getTime();
  }
  if (isNaN(ms) || ms === 0) return "";
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 30) return `${day}d ago`;
  return `${Math.floor(day / 30)}mo ago`;
}
