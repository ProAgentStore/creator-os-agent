import { Hono } from "hono";
import { callerInstagramCredentials, postInstagramReel } from "./instagram";
import { runScan, type Candidate } from "./scan";
import { QUEUE_EXPIRY_MS, eligibility, type LogEntry } from "./limits";

interface Env {
	AGENT: DurableObjectNamespace;
}

const MODEL = "claude-sonnet-4-6";

interface QueueEntry {
	id: string;
	queuedAt: number;
	platform: string;
	mediaRef: string;
	caption: string; // platform-adapted, never the base caption
	reason: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
	c.json({
		agent: "creator-os-agent",
		status: "ok",
		pipelines: ["scan", "draft", "publish", "cross-post", "queue-drain"],
		crons: { scan: "09:00 AEST daily", drain: "10:00/15:00/20:00 AEST" },
		postingRoutes: { instagram: "POST /post/instagram (X-Meta-Token, X-IG-User-ID)" },
		suggestions: "GET /suggestions (refreshed by daily scan cron; POST /scan to refresh now)",
		aiBilling: "caller-provided",
	}));

// ---- suggestions (daily scan output) ----

app.get("/suggestions", async (c) => c.json(await agentDo(c.env).getSuggestions()));

app.post("/scan", async (c) => c.json(await agentDo(c.env).scan()));

// ---- queue + log (backed by the agent Durable Object) ----

app.get("/queue", async (c) => c.json(await agentDo(c.env).getQueue()));

app.post("/queue", async (c) => {
	const body = await c.req.json<Omit<QueueEntry, "id" | "queuedAt">>();
	if (!body.platform || !body.caption || !body.reason) {
		return c.json({ error: "platform, caption, reason required" }, 400);
	}
	const entry = await agentDo(c.env).enqueue(body);
	return c.json({ queued: entry });
});

app.delete("/queue/:id", async (c) => {
	const result = await agentDo(c.env).dequeue(c.req.param("id"));
	return c.json(result, result.dropped ? 200 : 404);
});

app.get("/log", async (c) => c.json(await agentDo(c.env).getLog()));

app.post("/drain", async (c) => c.json(await agentDo(c.env).drain()));

// ---- posting routes (caller-provided credentials — never stored) ----

app.post("/post/instagram", async (c) => {
	const creds = callerInstagramCredentials(c.req.raw);
	if (!creds) {
		return c.json({ error: "credentials_required", message: "Pass X-Meta-Token and X-IG-User-ID headers." }, 402);
	}
	const { video_url, caption, force } = await c.req.json<{ video_url: string; caption: string; force?: boolean }>();
	if (!video_url || !caption) return c.json({ error: "video_url and caption required" }, 400);

	const dObj = agentDo(c.env);
	if (!force) {
		const check = await dObj.eligible("instagram");
		if (!check.eligible) {
			const entry = await dObj.enqueue({
				platform: "instagram",
				mediaRef: video_url,
				caption,
				reason: check.reason,
			});
			return c.json({ posted: false, queued: entry, reason: check.reason });
		}
	}

	const result = await postInstagramReel(creds, video_url, caption);
	await dObj.logPost({
		at: Date.now(),
		platform: "instagram",
		result: result.ok ? "SUCCESS" : "FAILED",
		attempts: 1,
		linkOrError: result.ok ? (result.permalink ?? result.mediaId ?? "posted") : `${result.phase}: ${result.error}`,
	});
	if (!result.ok) {
		// Policy: failed posts are queued for retry, never dropped
		const entry = await dObj.enqueue({
			platform: "instagram",
			mediaRef: video_url,
			caption,
			reason: `post failed at ${result.phase}: ${(result.error ?? "").slice(0, 120)}`,
		});
		return c.json({ ...result, queued: entry }, 502);
	}
	return c.json(result);
});

app.post("/chat", async (c) => {
	const credentials = callerAiCredentials(c.req.raw);
	if (!credentials) {
		return c.json({
			error: "caller_ai_credentials_required",
			message: "Pass X-CF-Account-ID and X-CF-AI-Token.",
		}, 402);
	}
	const { message } = await c.req.json<{ message: string }>();
	const result = await runCallerWorkersAi(credentials, {
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: message },
		],
	});
	return c.json(result);
});

const SYSTEM_PROMPT =
	"You are Creator OS, a personal AI content agent. You scan trending AI/tech news, draft platform-adapted social posts in the owner's voice (funny, punchy, never corporate), and manage the publish pipeline. Captions per platform: X punchy 1-liner 0-2 hashtags; Instagram hook-first 3-6 hashtags no raw URLs; TikTok hook-first 3-5 tags no URLs; Facebook conversational 0-2 tags. NEVER publish without explicit owner approval. Blocked posts are queued, never dropped. Always credit sources by name.";

function agentDo(env: Env) {
	const stub = env.AGENT.get(env.AGENT.idFromName("main"));
	return {
		getQueue: () => doCall<QueueEntry[]>(stub, "/do/queue"),
		enqueue: (e: Omit<QueueEntry, "id" | "queuedAt">) => doCall<QueueEntry>(stub, "/do/enqueue", e),
		dequeue: (id: string) => doCall<{ dropped: boolean }>(stub, "/do/dequeue", { id }),
		getLog: () => doCall<LogEntry[]>(stub, "/do/log"),
		logPost: (e: LogEntry) => doCall<{ ok: boolean }>(stub, "/do/log-post", e),
		eligible: (platform: string) => doCall<{ eligible: boolean; reason: string }>(stub, "/do/eligible", { platform }),
		drain: () => doCall<{ posted: number; kept: number; expired: number }>(stub, "/do/drain", {}),
		scan: () => doCall<{ found: number; scannedAt: number }>(stub, "/do/scan", {}),
		getSuggestions: () => doCall<{ scannedAt: number | null; candidates: Candidate[] }>(stub, "/do/suggestions"),
	};
}

async function doCall<T>(stub: DurableObjectStub, path: string, body?: unknown): Promise<T> {
	const res = await stub.fetch("https://do" + path, {
		method: body === undefined ? "GET" : "POST",
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return res.json<T>();
}

function callerAiCredentials(request: Request): { accountId: string; token: string } | null {
	const accountId = request.headers.get("X-CF-Account-ID")?.trim();
	const token = request.headers.get("X-CF-AI-Token")?.trim();
	if (!accountId || !token) return null;
	return { accountId, token };
}

async function runCallerWorkersAi(credentials: { accountId: string; token: string }, body: unknown): Promise<unknown> {
	const encodedModel = MODEL.split("/").map(encodeURIComponent).join("/");
	const res = await fetch(
		"https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(credentials.accountId) + "/ai/run/" + encodedModel,
		{
			method: "POST",
			headers: { Authorization: "Bearer " + credentials.token, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) return { error: "caller_workers_ai_failed", status: res.status, details: data };
	if (data && typeof data === "object" && "result" in data) return (data as { result: unknown }).result;
	return data;
}

export class GeneratedAgentDO {
	constructor(private state: DurableObjectState, private env: Env) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/do/")) return this.handleDo(url.pathname, request);
		return app.fetch(request, this.env);
	}

	private async handleDo(path: string, request: Request): Promise<Response> {
		switch (path) {
			case "/do/queue":
				return json(await this.queue());
			case "/do/enqueue": {
				const body = await request.json<Omit<QueueEntry, "id" | "queuedAt">>();
				const entry: QueueEntry = { ...body, id: crypto.randomUUID(), queuedAt: Date.now() };
				const q = await this.queue();
				q.push(entry);
				await this.state.storage.put("post-queue", q);
				await this.log({ at: Date.now(), platform: entry.platform, result: "QUEUED", attempts: 0, linkOrError: entry.reason });
				return json(entry);
			}
			case "/do/dequeue": {
				const { id } = await request.json<{ id: string }>();
				const q = await this.queue();
				const entry = q.find((e) => e.id === id);
				if (!entry) return json({ dropped: false });
				await this.state.storage.put("post-queue", q.filter((e) => e.id !== id));
				await this.log({ at: Date.now(), platform: entry.platform, result: "DROPPED", attempts: 0, linkOrError: `owner dropped: ${entry.caption.slice(0, 60)}` });
				return json({ dropped: true });
			}
			case "/do/log":
				return json((await this.state.storage.get<LogEntry[]>("posting-log")) ?? []);
			case "/do/log-post": {
				await this.log(await request.json<LogEntry>());
				return json({ ok: true });
			}
			case "/do/eligible": {
				const { platform } = await request.json<{ platform: string }>();
				const logEntries = (await this.state.storage.get<LogEntry[]>("posting-log")) ?? [];
				return json(eligibility(platform, logEntries, Date.now()));
			}
			case "/do/drain":
				return json(await this.drain());
			case "/do/scan": {
				const candidates = await runScan();
				const scannedAt = Date.now();
				await this.state.storage.put("suggestions", { scannedAt, candidates });
				return json({ found: candidates.length, scannedAt });
			}
			case "/do/suggestions":
				return json(
					(await this.state.storage.get<{ scannedAt: number; candidates: Candidate[] }>("suggestions")) ?? {
						scannedAt: null,
						candidates: [],
					},
				);
			default:
				return json({ error: "unknown DO path" }, 404);
		}
	}

	private async queue(): Promise<QueueEntry[]> {
		return (await this.state.storage.get<QueueEntry[]>("post-queue")) ?? [];
	}

	private async log(entry: LogEntry): Promise<void> {
		const logEntries = (await this.state.storage.get<LogEntry[]>("posting-log")) ?? [];
		logEntries.push(entry);
		await this.state.storage.put("posting-log", logEntries.slice(-500));
	}

	/** Retry queued posts oldest-first when limits allow; expire >72h. */
	private async drain(): Promise<{ posted: number; kept: number; expired: number }> {
		const now = Date.now();
		const q = await this.queue();
		const logEntries = (await this.state.storage.get<LogEntry[]>("posting-log")) ?? [];
		const kept: QueueEntry[] = [];
		let posted = 0;
		let expired = 0;

		for (const entry of q.sort((a, b) => a.queuedAt - b.queuedAt)) {
			if (now - entry.queuedAt > QUEUE_EXPIRY_MS) {
				expired++;
				await this.log({ at: now, platform: entry.platform, result: "EXPIRED", attempts: 0, linkOrError: "queued >72h" });
				continue;
			}
			if (!eligibility(entry.platform, logEntries, now).eligible) {
				kept.push(entry);
				continue;
			}
			// TODO: dispatch to the owner's posting route (local browser runner task for
			// x/facebook/tiktok; instagram needs stored credentials which the platform key
			// vault does not support yet — caller-credential posts happen via /post/instagram).
			kept.push(entry); // keep until dispatch exists — never silently drop
		}

		await this.state.storage.put("post-queue", kept);
		return { posted, kept: kept.length, expired };
	}
}

export default {
	fetch: app.fetch,
	async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		if (event.cron === "0 23 * * *") {
			await agentDo(env).scan();
		} else {
			await agentDo(env).drain();
		}
	},
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
