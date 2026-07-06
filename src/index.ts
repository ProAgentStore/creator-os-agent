import { Hono } from "hono";

interface Env {}

const MODEL = "claude-sonnet-4-6";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({
	agent: "creator-os-agent",
	status: "ok",
	aiBilling: "caller-provided",
	requiredHeaders: ["X-CF-Account-ID", "X-CF-AI-Token"],
}));

app.post("/chat", async (c) => {
	const credentials = callerAiCredentials(c.req.raw);
	if (!credentials) {
		return c.json({
			error: "caller_ai_credentials_required",
			message: "Pass your own Cloudflare Workers AI credentials with X-CF-Account-ID and X-CF-AI-Token. The platform will not spend its Workers AI account for this agent.",
		}, 402);
	}
	const { message } = await c.req.json<{ message: string }>();
	const result = await runCallerWorkersAi(credentials, {
		messages: [
			{ role: "system", content: "You are Creator OS. Personal AI content agent: scheduled news scans, platform-adapted post drafts in your voice, per-platform rate limits with a retry queue, and publishing through your own logged-in browser sessions via the local runner. Explicit approval before anything posts." },
			{ role: "user", content: message },
		],
	});
	return c.json(result);
});

function callerAiCredentials(request: Request): { accountId: string; token: string } | null {
	const accountId = request.headers.get("X-CF-Account-ID")?.trim();
	const token = request.headers.get("X-CF-AI-Token")?.trim();
	if (!accountId || !token) return null;
	return { accountId, token };
}

async function runCallerWorkersAi(credentials: { accountId: string; token: string }, body: unknown): Promise<unknown> {
	const encodedModel = MODEL.split("/").map(encodeURIComponent).join("/");
	const res = await fetch("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(credentials.accountId) + "/ai/run/" + encodedModel, {
		method: "POST",
		headers: {
			"Authorization": "Bearer " + credentials.token,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) return { error: "caller_workers_ai_failed", status: res.status, details: data };
	if (data && typeof data === "object" && "result" in data) return (data as { result: unknown }).result;
	return data;
}

export class GeneratedAgentDO {
	constructor(private state: DurableObjectState, private env: Env) {}

	async fetch(request: Request): Promise<Response> {
		return app.fetch(request, this.env);
	}
}

export default app;
