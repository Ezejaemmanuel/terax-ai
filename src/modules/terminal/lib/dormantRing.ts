const MIN_BYTE_CAP = 256 * 1024;
const DEFAULT_CHUNK_CAP = 256;
// Raw PTY bytes per line, intentionally generous (ANSI colour output is well
// under this) so the dormant buffer never drops anything the live scrollback
// would still show. This ties the background-buffer size to the scrollback
// preference instead of a fixed cap.
const BYTES_PER_LINE = 512;

export function dormantByteCapForScrollback(scrollbackLines: number): number {
  const lines = Number.isFinite(scrollbackLines) ? Math.floor(scrollbackLines) : 0;
  return Math.max(MIN_BYTE_CAP, lines * BYTES_PER_LINE);
}

function chunkCapForBytes(byteCap: number): number {
  return Math.max(DEFAULT_CHUNK_CAP, Math.ceil(byteCap / 1024));
}

const OVERFLOW_NOTICE = new TextEncoder().encode(
  "\x1bc\x1b[2m[terax: dropped output during hibernation]\x1b[0m\r\n",
);

export class DormantRing {
  private chunks: (Uint8Array | null)[] = [];
  private head = 0;
  private size = 0;
  private total = 0;
  private overflowed = false;

  private byteCap: number;
  private chunkCap: number;

  constructor(byteCap = MIN_BYTE_CAP, chunkCap = chunkCapForBytes(byteCap)) {
    this.byteCap = byteCap;
    this.chunkCap = chunkCap;
  }

  // Resize live (e.g. when the scrollback preference changes). Shrinking
  // immediately evicts the oldest chunks down to the new cap.
  setByteCap(byteCap: number): void {
    if (byteCap === this.byteCap) return;
    this.byteCap = byteCap;
    this.chunkCap = chunkCapForBytes(byteCap);
    this.evict();
  }

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (bytes.length >= this.byteCap) {
      this.chunks = [OVERFLOW_NOTICE, bytes.subarray(bytes.length - this.byteCap)];
      this.head = 0;
      this.size = 2;
      this.total = OVERFLOW_NOTICE.length + this.byteCap;
      this.overflowed = true;
      return;
    }
    this.chunks.push(bytes);
    this.size++;
    this.total += bytes.length;
    this.evict();
    if (this.head > 1024 && this.head > this.chunks.length / 2) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  private evict(): void {
    while (
      (this.total > this.byteCap || this.size > this.chunkCap) &&
      this.size > 1
    ) {
      const dropped = this.chunks[this.head]!;
      this.chunks[this.head] = null;
      this.head++;
      this.size--;
      this.total -= dropped.length;
      this.overflowed = true;
    }
  }

  drain(write: (bytes: Uint8Array) => void): void {
    if (this.overflowed) {
      const first = this.chunks[this.head];
      if (first !== OVERFLOW_NOTICE) write(OVERFLOW_NOTICE);
    }
    const end = this.head + this.size;
    for (let i = this.head; i < end; i++) {
      const c = this.chunks[i];
      if (c) write(c);
    }
    this.chunks = [];
    this.head = 0;
    this.size = 0;
    this.total = 0;
    this.overflowed = false;
  }

  byteLength(): number {
    return this.total;
  }
}
