export class SerialRefreshQueue {
  private readonly queued = new Set<string>();
  private readonly pending: string[] = [];
  private running = false;

  constructor(private readonly run: (key: string) => Promise<void>) {}

  enqueue(key: string): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.pending.push(key);
    void this.drain();
  }

  clear(): void {
    this.pending.length = 0;
    this.queued.clear();
  }

  get size(): number { return this.pending.length; }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const key = this.pending.shift();
        if (!key) continue;
        this.queued.delete(key);
        try {
          await this.run(key);
        } catch (error) {
          // A task owns its user-facing error handling. Keep later sources
          // flowing even when one renderer invocation rejects unexpectedly.
          console.error("[ChemDraw Paste] refresh queue task failed", error);
        }
      }
    } finally {
      this.running = false;
      if (this.pending.length > 0) void this.drain();
    }
  }
}
