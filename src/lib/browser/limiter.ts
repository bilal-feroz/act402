import { Act402Error } from "../errors";

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Counting semaphore with a bounded FIFO queue. When every slot is busy,
 * callers wait (up to `timeoutMs`); when the queue is full they get AT_CAPACITY.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
  ) {}

  get stats() {
    return { active: this.active, queued: this.queue.length, max: this.max };
  }

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(
        new Act402Error("AT_CAPACITY", "All browser slots are busy and the queue is full. Retry in a few seconds.", { retry_after_seconds: 10 }),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new Act402Error("AT_CAPACITY", "Timed out waiting for a free browser slot. Retry in a few seconds.", { retry_after_seconds: 10 }));
        }, Math.max(0, timeoutMs)),
      };
      this.queue.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.releaser());
      } else {
        this.active--;
      }
    };
  }
}
