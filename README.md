# Creator OS

Personal AI content agent: scheduled news scans, platform-adapted post drafts in your voice, per-platform rate limits with a retry queue, and publishing through your own logged-in browser sessions via the local runner. Explicit approval before anything posts.

## AI billing

This generated agent does not use the ProAgentStore Cloudflare Workers AI binding by default. AI calls require caller-provided Cloudflare Workers AI credentials:

- `X-CF-Account-ID`
- `X-CF-AI-Token`

That makes inference spend bill to the caller's Cloudflare account, not the ProAgentStore platform account.

## Development

```bash
pnpm install
pnpm dev
```

## Deploy

```bash
pnpm deploy
```
