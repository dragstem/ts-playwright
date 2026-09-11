import { describe, expect, it } from "vitest";
import { Semaphore } from "../apps/server/src/lib/semaphore";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Semaphore (Phase 0 / P0-T02)", () => {
  it("never exceeds the permit count under contention", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        sem.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(5);
          active -= 1;
        })
      )
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it("serializes fully with a single permit", async () => {
    const sem = new Semaphore(1);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        sem.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(2);
          active -= 1;
        })
      )
    );
    expect(peak).toBe(1);
  });

  it("releases the permit even when the task throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // A leaked permit would make this hang forever; race against a timeout marker.
    const outcome = await Promise.race([sem.run(async () => "ok"), delay(50).then(() => "timeout")]);
    expect(outcome).toBe("ok");
  });

  it("treats sub-one permit counts as one", async () => {
    const sem = new Semaphore(0);
    expect(await sem.run(async () => 42)).toBe(42);
  });
});
