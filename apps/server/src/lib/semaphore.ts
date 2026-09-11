// Minimal counting semaphore that bounds how many runner containers execute at once
// (Phase 0 / P0-T02). In-memory only: it provides backpressure against host exhaustion,
// not durability. The limit is adjustable at runtime (APP_MAX_CONCURRENT_RUNS / settings).
export class Semaphore {
  private limit: number;
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.limit = Math.max(1, Math.floor(permits));
    this.available = this.limit;
  }

  getLimit(): number {
    return this.limit;
  }

  // Raise or lower the concurrency limit at runtime. Raising wakes waiting tasks immediately;
  // lowering lets the extra in-flight tasks finish, after which fewer run concurrently.
  setLimit(permits: number): void {
    const next = Math.max(1, Math.floor(permits));
    this.available += next - this.limit;
    this.limit = next;
    this.drain();
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    this.available += 1;
    this.drain();
  }

  // Hand out free permits to waiting tasks (used by release and setLimit).
  private drain(): void {
    while (this.available > 0 && this.waiters.length > 0) {
      this.available -= 1;
      this.waiters.shift()?.();
    }
  }

  // Run a task while holding one permit; the permit is always released, even on throw.
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}
