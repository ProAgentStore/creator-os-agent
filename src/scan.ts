// Daily scan — gather repostable video candidates from public feeds.
// Runs from the 23:00 UTC cron (09:00 AEST) and on demand via POST /scan.

export interface Candidate {
	title: string;
	url: string;
	source: string;
	score: number; // upstream engagement (upvotes/points)
	isVideo: boolean;
	foundAt: number;
}

const SUBREDDITS = ["robotics", "artificial", "singularity", "videos+technology"];
const UA = { "User-Agent": "creator-os-agent/1.0 (ProAgentStore)" };

export async function runScan(): Promise<Candidate[]> {
	const results = await Promise.allSettled([hackerNews(), ...SUBREDDITS.map(reddit)]);
	const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

	// Prefer video content, then engagement; dedupe by URL
	const seen = new Set<string>();
	return all
		.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
		.sort((a, b) => Number(b.isVideo) - Number(a.isVideo) || b.score - a.score)
		.slice(0, 12);
}

async function hackerNews(): Promise<Candidate[]> {
	const res = await fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30", { headers: UA });
	const data = (await res.json()) as { hits?: Array<{ title: string; url?: string; points: number }> };
	const now = Date.now();
	return (data.hits ?? [])
		.filter((h) => h.url && /\b(ai|robot|llm|gpt|claude|gemini|agent|drone|humanoid)\b/i.test(h.title))
		.map((h) => ({
			title: h.title,
			url: h.url as string,
			source: "HackerNews",
			score: h.points,
			isVideo: isVideoUrl(h.url as string),
			foundAt: now,
		}));
}

async function reddit(sub: string): Promise<Candidate[]> {
	const res = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=25`, { headers: UA });
	const data = (await res.json()) as {
		data?: { children?: Array<{ data: { title: string; url: string; ups: number; is_video: boolean; stickied: boolean } }> };
	};
	const now = Date.now();
	return (data.data?.children ?? [])
		.map((c) => c.data)
		.filter((p) => !p.stickied && (p.is_video || isVideoUrl(p.url)))
		.map((p) => ({
			title: p.title,
			url: p.url,
			source: `r/${sub}`,
			score: p.ups,
			isVideo: true,
			foundAt: now,
		}));
}

function isVideoUrl(url: string): boolean {
	return /youtube\.com|youtu\.be|v\.redd\.it|vimeo\.com|\.mp4/i.test(url);
}
