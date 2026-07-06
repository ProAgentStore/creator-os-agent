// Instagram Reels posting via Graph API (v25.0) with caller-provided credentials.
// The owner's Meta token is passed per-request in headers — never stored on the platform.
// Flow: create REELS container from a hosted video_url → poll status → publish → permalink.

const GRAPH = "https://graph.facebook.com/v25.0";

export interface InstagramCredentials {
	token: string;
	igUserId: string;
}

export interface InstagramPostResult {
	ok: boolean;
	mediaId?: string;
	permalink?: string;
	error?: string;
	phase?: "container" | "processing" | "publish" | "permalink";
}

export function callerInstagramCredentials(request: Request): InstagramCredentials | null {
	const token = request.headers.get("X-Meta-Token")?.trim();
	const igUserId = request.headers.get("X-IG-User-ID")?.trim();
	if (!token || !igUserId) return null;
	return { token, igUserId };
}

export async function postInstagramReel(
	creds: InstagramCredentials,
	videoUrl: string,
	caption: string,
): Promise<InstagramPostResult> {
	// 1. Create media container — Instagram fetches the hosted video itself
	const container = await graphPost(creds.token, `/${creds.igUserId}/media`, {
		media_type: "REELS",
		video_url: videoUrl,
		caption,
	});
	if (!container.id) {
		return { ok: false, phase: "container", error: JSON.stringify(container).slice(0, 400) };
	}

	// 2. Poll processing status (up to ~100s)
	let status = "IN_PROGRESS";
	for (let i = 0; i < 25 && status !== "FINISHED"; i++) {
		await sleep(4000);
		const check = await graphGet(creds.token, `/${container.id}?fields=status_code`);
		status = check.status_code ?? status;
		if (status === "ERROR") {
			return { ok: false, phase: "processing", error: JSON.stringify(check).slice(0, 400) };
		}
	}
	if (status !== "FINISHED") {
		return { ok: false, phase: "processing", error: `still ${status} after 100s — container ${container.id}` };
	}

	// 3. Publish
	const published = await graphPost(creds.token, `/${creds.igUserId}/media_publish`, {
		creation_id: container.id,
	});
	if (!published.id) {
		return { ok: false, phase: "publish", error: JSON.stringify(published).slice(0, 400) };
	}

	// 4. Permalink (best effort)
	const media = await graphGet(creds.token, `/${published.id}?fields=permalink`);
	return { ok: true, mediaId: published.id, permalink: media.permalink };
}

async function graphPost(token: string, endpoint: string, params: Record<string, string>): Promise<Record<string, string>> {
	const body = new URLSearchParams({ ...params, access_token: token });
	const res = await fetch(GRAPH + endpoint, { method: "POST", body });
	return res.json().catch(() => ({}));
}

async function graphGet(token: string, endpoint: string): Promise<Record<string, string>> {
	const sep = endpoint.includes("?") ? "&" : "?";
	const res = await fetch(`${GRAPH}${endpoint}${sep}access_token=${encodeURIComponent(token)}`);
	return res.json().catch(() => ({}));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
