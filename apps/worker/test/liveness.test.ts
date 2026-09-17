import { describe, expect, it } from "@effect/vitest";
import { runCandidates } from "../src/sync/liveness.ts";

/**
 * The bug this guards against: knowing *which* workflow instance owns an
 * account. The handler used to probe a fixed id (`listing-<login>`) while the
 * run it actually started could carry a different one, so a live run was
 * invisible to both the liveness check and the dedupe probe. The recorded id
 * must therefore always be the first candidate, and the legacy ids only a
 * fallback — never the other way round.
 */

const LOGIN = "coldter";

const NOW = new Date("2026-09-17T12:00:00.000Z");

describe("runCandidates", () => {
  it("tries the recorded owner on both handles before any legacy id", () => {
    const candidates = runCandidates(LOGIN, "listing", "listing-coldter-run-42", NOW);

    expect(candidates.slice(0, 2)).toEqual([
      { handle: "listing", id: "listing-coldter-run-42" },
      { handle: "refresh", id: "listing-coldter-run-42" },
    ]);
  });

  it("keeps the legacy listing id reachable for a paused listing", () => {
    // The listing publishes `paused` while it sleeps out a rate limit, and the
    // refresh does too — so the phase cannot decide which handle to probe.
    const ids = runCandidates(LOGIN, "paused", null, NOW).map((candidate) => candidate.id);

    expect(ids).toContain(`listing-${LOGIN}`);
    expect(ids).toContain(`refresh-${LOGIN}-2026-09-17`);
  });

  it("still finds a legacy refresh that started before midnight UTC", () => {
    const ids = runCandidates(LOGIN, "embedding", null, NOW).map((candidate) => candidate.id);

    expect(ids).toContain(`refresh-${LOGIN}-2026-09-16`);
  });

  it("ignores an empty recorded id instead of probing it", () => {
    const candidates = runCandidates(LOGIN, "listing", "", NOW);

    expect(candidates.every((candidate) => candidate.id.length > 0)).toBe(true);
    expect(candidates).toEqual([
      { handle: "listing", id: `listing-${LOGIN}` },
      { handle: "refresh", id: `refresh-${LOGIN}-2026-09-17` },
      { handle: "refresh", id: `refresh-${LOGIN}-2026-09-16` },
    ]);
  });
});
