import { describe, expect, it } from "vitest";
import { Semaphore } from "../apps/server/src/lib/semaphore";

describe("Semaphore (adjustable concurrency)", () => {
  it("bounds concurrent holders to the limit", async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    let third = false;
    const pending = sem.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false); // blocked at limit 2
    sem.release();
    await pending;
    expect(third).toBe(true);
  });

  it("wakes a waiting task immediately when the limit is raised", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    let woke = false;
    const pending = sem.acquire().then(() => {
      woke = true;
    });
    await Promise.resolve();
    expect(woke).toBe(false);
    sem.setLimit(2); // raising the limit hands the waiter a permit
    await pending;
    expect(woke).toBe(true);
    expect(sem.getLimit()).toBe(2);
  });

  it("releases the permit even when the task throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });
});
