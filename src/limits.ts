// Publishing rate limits — the account-safety core. Pure functions, unit-tested.

export const DAILY_CAPS: Record<string, number> = { facebook: 2, x: 3, instagram: 1, tiktok: 2 };
export const PLATFORM_GAP_MS = 6 * 3600_000; // 6h per platform
export const GLOBAL_GAP_MS = 30 * 60_000; // 30min between any two posts
export const QUEUE_EXPIRY_MS = 72 * 3600_000; // 72h then expire

export interface LogEntry {
	at: number;
	platform: string;
	result: "SUCCESS" | "FAILED" | "SKIPPED" | "QUEUED" | "EXPIRED" | "DROPPED";
	attempts: number;
	linkOrError: string;
}

export function eligibility(
	platform: string,
	logEntries: LogEntry[],
	now: number,
): { eligible: boolean; reason: string } {
	const successes = logEntries.filter((l) => l.result === "SUCCESS");
	// AEST midnight = 14:00 UTC. NOTE: Melbourne shifts to AEDT (UTC+11) in summer,
	// which moves the true local midnight to 13:00 UTC — the cap day is then offset
	// by 1h. Acceptable drift for a safety cap; revisit if it ever matters.
	const aestMidnightUtc = new Date(now).setUTCHours(14, 0, 0, 0);
	const todayStart = aestMidnightUtc - (now < aestMidnightUtc ? 86400_000 : 0);
	const todayOnPlatform = successes.filter((l) => l.platform === platform && l.at >= todayStart).length;
	if (todayOnPlatform >= (DAILY_CAPS[platform] ?? 1)) {
		return { eligible: false, reason: `daily cap reached for ${platform} (${todayOnPlatform}/${DAILY_CAPS[platform] ?? 1})` };
	}
	const lastOnPlatform = Math.max(0, ...successes.filter((l) => l.platform === platform).map((l) => l.at));
	if (now - lastOnPlatform < PLATFORM_GAP_MS) {
		return { eligible: false, reason: `6h gap not elapsed on ${platform}` };
	}
	const lastAny = Math.max(0, ...successes.map((l) => l.at));
	if (now - lastAny < GLOBAL_GAP_MS) {
		return { eligible: false, reason: "30min global gap not elapsed" };
	}
	return { eligible: true, reason: "" };
}
