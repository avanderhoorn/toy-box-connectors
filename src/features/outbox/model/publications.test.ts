import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { correctionKey, latestScheduledRun, publicationKey } from "./publications";

// Keys name local days, so these tests pin a zone whose clocks change on Sunday, November 1, 2026.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const local = (value: string) => new Date(value).getTime();

describe("the latest scheduled run", () => {
  test("is the schedule's latest local run at or before now", () => {
    const run = local("2026-10-27T16:00:00");
    expect(latestScheduledRun("0 16 * * 1-5", run)).toBe(run);
    expect(latestScheduledRun("0 16 * * 1-5", run + 1)).toBe(run);
    expect(latestScheduledRun("0 16 * * 1-5", run - 1)).toBe(local("2026-10-26T16:00:00"));
  });

  test.each(["0 9 31 2 *", "not a cron"])(
    "a schedule that can't run, like %s, has none",
    (cron) => {
      expect(latestScheduledRun(cron, local("2026-10-27T16:00:00"))).toBeNull();
    },
  );
});

describe("publication keys", () => {
  const daily = { series: "standup", period: "day", schedule: "0 16 * * 1-5" } as const;
  const weekly = { series: "release-notes", period: "week", schedule: "0 16 * * 5" } as const;

  test("a daily series keys each post by its run's day", () => {
    expect(publicationKey(daily, local("2026-10-27T16:05:00"))).toBe("standup/2026-10-27");
    expect(publicationKey(daily, local("2026-10-31T10:00:00"))).toBe("standup/2026-10-30");
  });

  test("a run that publishes after midnight still lands in its own period", () => {
    expect(publicationKey(daily, local("2026-10-28T00:30:00"))).toBe("standup/2026-10-27");
    expect(publicationKey(weekly, local("2026-11-02T09:00:00"))).toBe("release-notes/2026-10-26");
  });

  test("a weekly series keys each post by its run's Monday until the next run", () => {
    expect(publicationKey(weekly, local("2026-10-30T16:00:00"))).toBe("release-notes/2026-10-26");
    expect(publicationKey(weekly, local("2026-11-06T15:59:00"))).toBe("release-notes/2026-10-26");
    expect(publicationKey(weekly, local("2026-11-06T16:00:00"))).toBe("release-notes/2026-11-02");
  });

  test("a week that changes clocks still starts on its Monday", () => {
    const sunday = { series: "release-notes", period: "week", schedule: "0 23 * * 0" } as const;
    expect(publicationKey(sunday, local("2026-11-01T23:30:00"))).toBe("release-notes/2026-10-26");
  });

  test("a week can start in the year before", () => {
    expect(publicationKey(weekly, local("2027-01-01T17:00:00"))).toBe("release-notes/2026-12-28");
  });

  test("a series whose schedule can't run has no key", () => {
    expect(publicationKey({ ...weekly, schedule: "0 9 31 2 *" }, Date.now())).toBeNull();
  });

  test("a correction is keyed after the post it replaces", () => {
    expect(correctionKey("release-notes/2026-10-26")).toBe("release-notes/2026-10-26/correction");
  });
});
