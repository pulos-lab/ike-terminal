/**
 * Shared concurrency utilities — limiter and batch processing.
 */

/**
 * Create a reusable concurrency limiter (semaphore pattern).
 * Returns an async wrapper that queues excess calls.
 */
export function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      // Wait for a finisher to hand over its slot directly (see finally below).
      // `active` already counts our slot when we wake up — no increment here.
      // This avoids the race where a new caller slips in between a finisher's
      // decrement and the waiter waking up, exceeding the limit.
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active++;
    }
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) {
        // Hand the slot over directly — `active` stays unchanged, so no other
        // caller can sneak in before the waiter resumes.
        next();
      } else {
        active--;
      }
    }
  };
}

/**
 * Process items with a concurrency limit (worker pool pattern).
 * Runs up to `maxConcurrent` items in parallel.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  maxConcurrent: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(maxConcurrent, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
