import { Hono } from "hono";

interface Env {
	AGENT: DurableObjectNamespace;
}

const MODEL = "claude-sonnet-4-6";

// Hard publishing limits — protect the owner's accounts
const DAILY_CAPS: Record<string, number> = { facebook: 2, x: 3, instagram: 1, tiktok: 2 };
const PLATFORM_GAP_MS = 6 * 3600_000; // 6h per platform
const GLOBAL_GAP_MS = 30 * 60_000; // 30min between any two posts
const QUEUE_EXPIRY_MS = 72 * 3600_000; // 72h then expire

interface QueueEntry {
	id: string;
	queuedAt: number;
	platform: string;
	mediaRef: string;
	caption: string; // platform-adapted, never the base caption
	reason: string;
}

interface LogEntry {
	at: number;
	platform: string;
	result: "SUCCESS" | "FAILED" | "SKIPPED" | "QUEUED" | "EXPIRED";
	attempts: number;
	linkOrError: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) =>
	c.json({
		agent: "creator-os-agent",
		status: "ok",
		pipelines: ["scan", "draft", "publish", "cross-post", "queue-drain"],
		crons: { scan: "09:00 AEST daily", drain: "10:00/15:00/20:00 AEST" },
		aiBilling: "caller-provided",
		requiredHeaders: ["X-CF-Account-ID", "X-CF-AI-Token"],
	}));

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

app.get("/log", async (c) => c.json(await agentDo(c.env).getLog()));

app.post("/drain", async (c) => c.json(await agentDo(c.env).drain()));

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
		getLog: () => doCall<LogEntry[]>(stub, "/do/log"),
		drain: () => doCall<{ posted: number; kept: number; expired: number }>(stub, "/do/drain", {}),
		scan: () => doCall<{ status: string }>(stub, "/do/scan", {}),
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
			case "/do/log":
				return json((await this.state.storage.get<LogEntry[]>("posting-log")) ?? []);
			case "/do/drain":
				return json(await this.drain());
			case "/do/scan":
				// TODO: full scan pipeline (web search sources → score → present).
				// Blocked on: owner notification surface (Discord webhook / messenger integration).
				await this.state.storage.put("last-scan", Date.now());
				return json({ status: "scan recorded; presentation surface pending messenger integration" });
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
			if (!this.eligible(entry.platform, logEntries, now)) {
				kept.push(entry);
				continue;
			}
			// TODO: dispatch to the owner's posting route (local browser runner task for
			// x/facebook/tiktok, API call for instagram/bluesky). Blocked on runner post.* task types.
			kept.push(entry); // keep until dispatch exists — never silently drop
		}

		await this.state.storage.put("post-queue", kept);
		return { posted, kept: kept.length, expired };
	}

	private eligible(platform: string, logEntries: LogEntry[], now: number): boolean {
		const successes = logEntries.filter((l) => l.result === "SUCCESS");
		const todayStart = new Date(now).setUTCHours(14, 0, 0, 0) - (now < new Date(now).setUTCHours(14, 0, 0, 0) ? 86400_000 : 0); // AEST midnight = 14:00 UTC
		const todayOnPlatform = successes.filter((l) => l.platform === platform && l.at >= todayStart).length;
		if (todayOnPlatform >= (DAILY_CAPS[platform] ?? 1)) return false;
		const lastOnPlatform = Math.max(0, ...successes.filter((l) => l.platform === platform).map((l) => l.at));
		if (now - lastOnPlatform < PLATFORM_GAP_MS) return false;
		const lastAny = Math.max(0, ...successes.map((l) => l.at));
		if (now - lastAny < GLOBAL_GAP_MS) return false;
		return true;
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
