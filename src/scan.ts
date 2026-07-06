// Daily scan — gather repostable video candidates from public feeds.
// Runs from the 23:00 UTC cron (09:00 AEST) and on demand via POST /scan.
// Note: Reddit blocks Cloudflare Worker IPs — kept best-effort; YouTube RSS is the video workhorse.

export interface Candidate {
	title: string;
	url: string;
	source: string;
	score: number; // upstream engagement (points) or recency rank for RSS
	isVideo: boolean;
	foundAt: number;
}

const SUBREDDITS = ["robotics", "artificial", "singularity"];

// Verified channels from oc-config docs/creator-os/news-sources.md
const YOUTUBE_CHANNELS: Array<[string, string]> = [
	["UCbfYPyITQ-7l4upoX8nvctg", "Two Minute Papers"],
	["UCZHmQk67mSJgfCCTn7xBfew", "Yannic Kilcher"],
	["UCZ2MeG5jTIqgzEMiByrIzsw", "AI Explained"],
	["UChpleBmo18P08aKCIgti38g", "Matt Wolfe"],
	["UCbY9xX3_jW5c2fjlZVBI4cg", "TheAIGRID"],
	["UCsBjURrPoezykLs9EqgamOA", "Fireship"],
];

const UA = { "User-Agent": "creator-os-agent/1.0 (ProAgentStore)" };
const FRESH_MS = 48 * 3600_000; // videos from the last 48h only

export async function runScan(): Promise<Candidate[]> {
	const results = await Promise.allSettled([
		hackerNews(),
		...YOUTUBE_CHANNELS.map(([id, name]) => youtubeRss(id, name)),
		...SUBREDDITS.map(reddit),
	]);
	const all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

	// Prefer video content, then engagement; dedupe by URL
	const seen = new Set<string>();
	return all
		.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
		.sort((a, b) => Number(b.isVideo) - Number(a.isVideo) || b.score - a.score)
		.slice(0, 12);
}

async function youtubeRss(channelId: string, channelName: string): Promise<Candidate[]> {
	const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: UA });
	const xml = await res.text();
	const now = Date.now();
	const out: Candidate[] = [];
	const entries = xml.split("<entry>").slice(1);
	for (const entry of entries.slice(0, 5)) {
		const title = between(entry, "<title>", "</title>");
		const videoId = between(entry, "<yt:videoId>", "</yt:videoId>");
		const published = between(entry, "<published>", "</published>");
		if (!title || !videoId || !published) continue;
		const age = now - Date.parse(published);
		if (age > FRESH_MS) continue;
		out.push({
			title: decodeEntities(title),
			url: `https://www.youtube.com/watch?v=${videoId}`,
			source: channelName,
			score: Math.max(1, Math.round((FRESH_MS - age) / 3600_000)), // fresher = higher
			isVideo: true,
			foundAt: now,
		});
	}
	return out;
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
	if (!res.ok) return []; // Reddit blocks CF Worker IPs — best effort
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

function between(text: string, start: string, end: string): string | null {
	const i = text.indexOf(start);
	if (i < 0) return null;
	const j = text.indexOf(end, i + start.length);
	if (j < 0) return null;
	return text.slice(i + start.length, j);
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function isVideoUrl(url: string): boolean {
	return /youtube\.com|youtu\.be|v\.redd\.it|vimeo\.com|\.mp4/i.test(url);
}
