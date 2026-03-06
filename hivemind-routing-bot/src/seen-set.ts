/**
 * Bounded set of seen tx hashes for idempotency.
 * Evicts oldest when at capacity so we don't grow unbounded.
 */

export const DEFAULT_MAX_SEEN = 5000;

export class SeenSet {
  private readonly hashes = new Set<string>();
  private readonly queue: string[] = [];
  private readonly maxSize: number;
  private readonly onEvict?: (txHash: string) => void;

  constructor(maxSize = DEFAULT_MAX_SEEN, onEvict?: (txHash: string) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  add(txHash: string): void {
    if (this.hashes.has(txHash)) return;
    this.hashes.add(txHash);
    this.queue.push(txHash);
    if (this.queue.length > this.maxSize) {
      const oldest = this.queue.shift();
      if (oldest) {
        this.hashes.delete(oldest);
        this.onEvict?.(oldest);
      }
    }
  }

  has(txHash: string): boolean {
    return this.hashes.has(txHash);
  }

  get size(): number {
    return this.hashes.size;
  }

  /** For persistence: return current queue (oldest first). */
  toArray(): string[] {
    return [...this.queue];
  }

  /** Restore from persisted array; evicts if over maxSize. */
  static fromArray(arr: string[], maxSize = DEFAULT_MAX_SEEN, onEvict?: (txHash: string) => void): SeenSet {
    const seen = new SeenSet(maxSize, onEvict);
    for (const h of arr) seen.add(h);
    return seen;
  }
}
