import { describe, it, expect } from 'vitest';
import { createConcurrencyLimiter, mapWithConcurrency } from '../concurrency.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createConcurrencyLimiter', () => {
  it('never exceeds the limit under contention (50 tasks, limit 3)', async () => {
    const limit = 3;
    const limiter = createConcurrencyLimiter(limit);
    let active = 0;
    let maxObserved = 0;

    const tasks = Array.from({ length: 50 }, (_, i) =>
      limiter(async () => {
        active++;
        maxObserved = Math.max(maxObserved, active);
        // Kilka punktów await, żeby sprowokować przeplatanie mikrotasków
        // (to tu poprzednia wersja gubiła limit: nowy caller wciskał się
        // między dekrement finishera a obudzenie waitera).
        await delay(1 + (i % 3));
        maxObserved = Math.max(maxObserved, active);
        await Promise.resolve();
        active--;
        return i;
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(50);
    expect(maxObserved).toBeLessThanOrEqual(limit);
    expect(active).toBe(0);
  });

  it('releases slots after task failure', async () => {
    const limiter = createConcurrencyLimiter(1);
    await expect(
      limiter(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Slot musi być zwolniony mimo wyjątku — kolejne zadanie przechodzi
    const result = await limiter(async () => 42);
    expect(result).toBe(42);
  });

  it('returns task results in order of resolution', async () => {
    const limiter = createConcurrencyLimiter(2);
    const results = await Promise.all([
      limiter(async () => {
        await delay(5);
        return 'a';
      }),
      limiter(async () => 'b'),
      limiter(async () => 'c'),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });
});

describe('mapWithConcurrency', () => {
  it('processes all items without exceeding the limit', async () => {
    let active = 0;
    let maxObserved = 0;
    const processed: number[] = [];

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (item) => {
      active++;
      maxObserved = Math.max(maxObserved, active);
      await delay(1);
      processed.push(item);
      active--;
    });

    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(maxObserved).toBeLessThanOrEqual(3);
  });
});
