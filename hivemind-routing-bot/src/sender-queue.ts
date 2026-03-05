/**
 * Per-sender FIFO queue so we process one message per sender per tick
 * and never drop rapid followups (markSeen only when handled).
 */

export const MAX_PENDING_PER_SENDER = 10;

export interface PendingMessage {
  tx_hash: string;
  sender: string;
  body: string;
}

export interface SenderPendingQueuesOptions {
  onDrop?: (txHash: string) => void;
}

export class SenderPendingQueues {
  private readonly queues = new Map<string, PendingMessage[]>();
  private readonly onDrop: (txHash: string) => void;

  constructor(options: SenderPendingQueuesOptions = {}) {
    this.onDrop = options.onDrop ?? (() => {});
  }

  enqueue(sender: string, txHash: string, body: string): void {
    let q = this.queues.get(sender);
    if (!q) {
      q = [];
      this.queues.set(sender, q);
    }
    if (q.length >= MAX_PENDING_PER_SENDER) {
      const dropped = q.shift();
      if (dropped) this.onDrop(dropped.tx_hash);
    }
    q.push({ tx_hash: txHash, sender, body });
  }

  drainOnePerSender(): PendingMessage[] {
    const out: PendingMessage[] = [];
    for (const [sender, q] of this.queues) {
      if (q.length > 0) {
        const item = q.shift();
        if (item) out.push(item);
      }
    }
    return out;
  }

  hasPending(sender?: string): boolean {
    if (sender) {
      const q = this.queues.get(sender);
      return Boolean(q && q.length > 0);
    }
    for (const q of this.queues.values()) {
      if (q.length > 0) return true;
    }
    return false;
  }
}
