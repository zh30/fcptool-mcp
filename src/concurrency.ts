/**
 * Per-key FIFO locks. fcptool cannot open the same library from two processes at
 * once (the second fails with "Library permissions error"), so every operation that
 * opens a library is serialized on that library's key, while operations on different
 * libraries run in parallel.
 *
 * acquire() enqueues on all keys synchronously, so operations submitted in order run
 * in order per key and multi-key operations (event copy) can never deadlock.
 */
export class KeyedLock {
  private tails = new Map<string, Promise<void>>();

  async acquire(keys: string[]): Promise<() => void> {
    const unique = [...new Set(keys)];
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    const waits: Promise<void>[] = [];
    for (const k of unique) {
      const prev = this.tails.get(k);
      if (prev) waits.push(prev);
      const tail = done.then(() => {
        if (this.tails.get(k) === tail) this.tails.delete(k);
      });
      this.tails.set(k, tail);
    }
    await Promise.all(waits);
    return release;
  }

  get activeKeys(): number {
    return this.tails.size;
  }
}

/** Caps concurrent fcptool processes (each costs ~1.4s CPU to boot Flexo). */
export class Semaphore {
  private queue: (() => void)[] = [];
  private inUse = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.inUse >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.inUse++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse--;
      this.queue.shift()?.();
    };
  }

  get stats() {
    return { max: this.max, running: this.inUse, queued: this.queue.length };
  }
}
