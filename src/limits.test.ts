import { describe, expect, it } from "vitest";
import { eligibility, type LogEntry } from "./limits";

// Fixed "now": 2026-07-06 18:00 UTC → AEST day started at 14:00 UTC same day
const NOW = Date.parse("2026-07-06T18:00:00Z");
const DAY_START = Date.parse("2026-07-06T14:00:00Z");

function success(platform: string, at: number): LogEntry {
	return { at, platform, result: "SUCCESS", attempts: 1, linkOrError: "x" };
}

describe("eligibility", () => {
	it("allows a platform with no history", () => {
		expect(eligibility("x", [], NOW).eligible).toBe(true);
	});

	it("blocks when the daily cap is reached (instagram: 1/day)", () => {
		const log = [success("instagram", DAY_START + 3600_000)];
		const r = eligibility("instagram", log, NOW);
		expect(r.eligible).toBe(false);
		expect(r.reason).toContain("daily cap");
	});

	it("cap resets after the AEST day boundary (older post also outside the 6h gap)", () => {
		// 9h before NOW: before the AEST day started AND outside the 6h platform gap —
		// isolates the day-boundary logic. (A post merely 1h before the boundary would
		// still be blocked by the gap; the rules compose.)
		const log = [success("instagram", NOW - 9 * 3600_000)];
		expect(eligibility("instagram", log, NOW).eligible).toBe(true);
	});

	it("yesterday's post inside the 6h gap still blocks — rules compose", () => {
		// 1h before day start = 5h before NOW: cap has reset, gap has not elapsed
		const log = [success("instagram", DAY_START - 3600_000)];
		const r = eligibility("instagram", log, NOW);
		expect(r.eligible).toBe(false);
		expect(r.reason).toContain("6h gap");
	});

	it("enforces the 6h per-platform gap even under the cap", () => {
		// x cap is 3/day; one post 2h ago → gap blocks
		const log = [success("x", NOW - 2 * 3600_000)];
		const r = eligibility("x", log, NOW);
		expect(r.eligible).toBe(false);
		expect(r.reason).toContain("6h gap");
	});

	it("enforces the 30min global gap across platforms", () => {
		const log = [success("facebook", NOW - 10 * 60_000)];
		const r = eligibility("x", log, NOW);
		expect(r.eligible).toBe(false);
		expect(r.reason).toContain("30min global gap");
	});

	it("allows a different platform once the global gap has passed", () => {
		const log = [success("facebook", NOW - 40 * 60_000)];
		expect(eligibility("x", log, NOW).eligible).toBe(true);
	});

	it("unknown platforms default to cap 1", () => {
		const log = [success("bluesky", DAY_START + 3600_000)];
		expect(eligibility("bluesky", log, NOW).eligible).toBe(false);
	});

	it("only SUCCESS entries count toward caps and gaps", () => {
		const log: LogEntry[] = [
			{ at: NOW - 60_000, platform: "instagram", result: "FAILED", attempts: 1, linkOrError: "e" },
			{ at: NOW - 60_000, platform: "instagram", result: "QUEUED", attempts: 0, linkOrError: "q" },
		];
		expect(eligibility("instagram", log, NOW).eligible).toBe(true);
	});
});
