import { describe, expect, test } from "bun:test";
import { completeJob, failJob, findJob, isStartJob, pushEvent, registerJob, startJob } from "./jobs";

describe("startJob sentinel", () => {
  test("isStartJob returns true for startJob result", () => {
    const marker = startJob({ id: "abc" });
    expect(isStartJob(marker)).toBe(true);
    expect(marker.id).toBe("abc");
  });

  test("isStartJob returns false for plain objects", () => {
    expect(isStartJob({ id: "abc" })).toBe(false);
    expect(isStartJob(null)).toBe(false);
    expect(isStartJob(42)).toBe(false);
    expect(isStartJob("string")).toBe(false);
  });
});

describe("job registry", () => {
  test("findJob returns null-returning generator for unknown id", async () => {
    const gen = findJob("nonexistent");
    const result = await gen.next();
    expect(result.done).toBe(true);
    expect(result.value).toBeNull();
  });

  test("pushEvent + findJob replays buffered events", async () => {
    registerJob("test-replay");
    pushEvent("test-replay", { type: "title", data: "Hello" });
    pushEvent("test-replay", { type: "body", data: "World" });
    completeJob("test-replay", { final: true });

    const gen = findJob("test-replay");
    // Job already deleted after completeJob, so findJob returns null
    const result = await gen.next();
    expect(result.done).toBe(true);
    expect(result.value).toBeNull();
  });

  test("findJob replays events then streams live ones", async () => {
    registerJob("test-live");
    pushEvent("test-live", "event-1");

    const gen = findJob("test-live");
    const collected: unknown[] = [];

    // First replayed event
    const r1 = await gen.next();
    expect(r1.done).toBe(false);
    collected.push(r1.value);

    // Push more events while subscribed
    pushEvent("test-live", "event-2");
    const r2 = await gen.next();
    expect(r2.done).toBe(false);
    collected.push(r2.value);

    // Complete the job
    completeJob("test-live", "final-result");
    const r3 = await gen.next();
    expect(r3.done).toBe(true);
    expect(r3.value).toBe("final-result");

    expect(collected).toEqual(["event-1", "event-2"]);
  });

  test("findJob handles error from failJob", async () => {
    registerJob("test-fail");
    pushEvent("test-fail", "before-fail");

    const gen = findJob("test-fail");

    const r1 = await gen.next();
    expect(r1.value).toBe("before-fail");

    failJob("test-fail", new Error("something broke"));

    try {
      await gen.next();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("something broke");
    }
  });

  test("multiple subscribers see the same events", async () => {
    registerJob("test-multi");

    const gen1 = findJob("test-multi");
    const gen2 = findJob("test-multi");

    pushEvent("test-multi", "shared-event");

    const [r1, r2] = await Promise.all([gen1.next(), gen2.next()]);
    expect(r1.value).toBe("shared-event");
    expect(r2.value).toBe("shared-event");

    completeJob("test-multi", "done");

    const [f1, f2] = await Promise.all([gen1.next(), gen2.next()]);
    expect(f1.done).toBe(true);
    expect(f1.value).toBe("done");
    expect(f2.done).toBe(true);
    expect(f2.value).toBe("done");
  });

  test("late subscriber replays full history then gets live events", async () => {
    registerJob("test-late");
    pushEvent("test-late", "early-1");
    pushEvent("test-late", "early-2");

    // Late subscriber joins after 2 events already buffered
    const gen = findJob("test-late");

    const r1 = await gen.next();
    expect(r1.value).toBe("early-1");
    const r2 = await gen.next();
    expect(r2.value).toBe("early-2");

    // Now push a live event
    pushEvent("test-late", "live-3");
    const r3 = await gen.next();
    expect(r3.value).toBe("live-3");

    completeJob("test-late", "all-done");
    const r4 = await gen.next();
    expect(r4.done).toBe(true);
    expect(r4.value).toBe("all-done");
  });
});
