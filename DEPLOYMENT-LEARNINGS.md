# Craft Agents Web Deployment — Learnings & Roadmap

## Goal

Deploy Craft Agents as a **web-accessible service**: a headless backend (WebSocket RPC) + a web frontend, hosted on Railway.

## Architecture Decision

The codebase already has clean client-server separation:
- **Backend:** `packages/server` + `packages/server-core` — headless WebSocket RPC server
- **Frontend:** `packages/ui` — React components (designed for Electron, reusable in browser)
- **Agent core:** `packages/shared` — agent orchestration, tool execution, config management

We created:
- `apps/web/` — Standalone Vite+React web client connecting via browser WebSocket
- `Dockerfile.server` — Headless server container (Bun + Python 3 + uv)
- `Dockerfile.web` — Nginx serving the built web client with WS proxy
- `docker-compose.yml` — Local two-service dev setup
- `railway.toml` — Railway deployment config

## Issues Encountered (in order)

### 1. Docker Build Failures
| Problem | Fix |
|---------|-----|
| `apps/marketing` referenced in Dockerfiles but doesn't exist | Removed references (`cdd14eb`) |
| `husky` prepare script fails during `bun install` (no git context) | Added `--ignore-scripts` flag (`b2a5b3a`) |

### 2. Railway Health Checks Failing
This was the longest debugging cycle. Railway requires HTTP health checks; the server was WebSocket-only.

| Problem | Fix |
|---------|-----|
| WS-only server — Railway's HTTP healthcheck gets no response | Added HTTP handler to `WsRpcServer` that returns 200 on any non-upgrade request (`8a659c1`) |
| Server listens on hardcoded port 9100; Railway assigns dynamic `$PORT` | Fall back to `process.env.PORT` (`750a22b`, `8864688`) |
| nginx config uses `${VAR:-default}` syntax which nginx can't parse | Switched to `.template` file with nginx's built-in `envsubst` (`c8fe982`) |
| Health endpoint only available after full bootstrap (slow/crashy) | Moved HTTP listener to a minimal `entrypoint.ts` that starts before any imports (`00e99ac`, `c82de2f`) |
| Boot crash → health returns 503 → Railway kills container | Health always returns 200; boot status in JSON body (`d0719cb`) |

### 3. Server Boot Crashes
Each crash only became visible after the previous one was fixed (no local reproduction — these surfaced only in Railway's runtime logs).

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| Module resolution failures | `@craft-agent/shared` missing 3 subpath exports (`agent/backend`, `config/models`, `utils/files`) | Added exports to `package.json` (`1a8ee29`) |
| `config-defaults.json` not found | `getBundledAssetsDir()` looks at `CRAFT_BUNDLED_ASSETS_ROOT` which wasn't set; defaults to `/app/resources/` (doesn't exist) | Set `CRAFT_BUNDLED_ASSETS_ROOT=/app/apps/electron` in Dockerfile (`4653e76`) |
| Config directory `/data/craft-agent` creation fails | Volume may not be mounted yet | Pre-create in Dockerfile (`f77eb0d`) |
| No workspace or LLM connection on fresh boot | Electron app has onboarding UI; headless server has none | Auto-create default workspace + Anthropic connection from `ANTHROPIC_API_KEY` env var (`ea399a6`) |

### 4. Sessions Start But Actions Never Complete
**Root cause:** The default permission mode is `"safe"` (Explore), which requires interactive UI approval for every tool call. In headless mode, there's no user to click "Allow", so tool executions hang forever.

**Fix:** Force `allow-all` permission mode on all workspaces during headless boot (`df2c116`).

### 5. Pi-Agent Subprocess (Investigated, Not Relevant)
We investigated the pi-agent subprocess spawning flow. Key finding: the default `providerType: 'anthropic'` uses the **Claude Agent SDK directly** (not the Pi subprocess), so `pi-agent-server` build issues are irrelevant for standard deployments.

## Current State

The server **should** boot and handle sessions end-to-end, but we haven't confirmed a fully working deployment yet. The fixes are incremental and untested as a whole.

## What To Do Next

### Immediate
1. **Test locally first** — `docker compose up` and verify:
   - Health endpoint returns `{"status":"ready"}`
   - WebSocket connection succeeds from web client
   - A chat message triggers agent tool execution and returns results
2. **Set `ANTHROPIC_API_KEY`** in Railway environment variables
3. **Set `CRAFT_SERVER_TOKEN`** or let auto-generation work (check logs for the generated token)
4. **Deploy to Railway** and monitor runtime logs

### Known Risks
- **stdout buffering in Docker:** The Claude Agent SDK subprocess communicates via JSONL on stdin/stdout. In headless Docker (no TTY), stdout may be fully buffered instead of line-buffered, causing the parent to hang waiting for responses. If this happens, set `NODE_OPTIONS=--max-old-space-size=4096` won't help — you need to ensure the SDK flushes stdout (or use `stdbuf -oL`).
- **No startup timeout:** If the agent subprocess fails to start, the parent waits indefinitely. Consider adding a timeout.
- **stderr logs may be invisible:** Debug logs from subprocesses go to stderr, which Railway may route differently. Check "Build Logs" vs "Deploy Logs" in Railway.
- **Web client is minimal:** The `apps/web/` client is a proof-of-concept. It needs auth, reconnection UX, and proper error handling before production use.

## Key Files

| File | Purpose |
|------|---------|
| `packages/server/src/entrypoint.ts` | Minimal HTTP server that starts before bootstrap |
| `packages/server/src/index.ts` | Full server bootstrap (config, sessions, WS) |
| `packages/server-core/src/bootstrap/headless-start.ts` | Headless defaults: workspace, connection, permissions |
| `packages/server-core/src/transport/server.ts` | WsRpcServer with HTTP health handler |
| `packages/shared/src/agent/backend/factory.ts` | Agent provider selection (anthropic vs pi) |
| `packages/shared/src/agent/backend/internal/runtime-resolver.ts` | SDK/binary path resolution |
| `apps/web/src/lib/ws-rpc-client.ts` | Browser WebSocket RPC client |
| `Dockerfile.server` | Server container |
| `Dockerfile.web` | Web client container |
| `docker-compose.yml` | Local dev setup |
| `railway.toml` | Railway deployment config |

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claude API access |
| `CRAFT_SERVER_TOKEN` | No | Auth token for WS connections (auto-generated if missing) |
| `PORT` | Auto (Railway) | HTTP/WS listen port |
| `CRAFT_BUNDLED_ASSETS_ROOT` | Set in Dockerfile | Path to `apps/electron` for config-defaults.json |
| `CRAFT_IS_PACKAGED` | Set in Dockerfile | Must be `false` for dev/server mode |
| `CRAFT_APP_ROOT` | No | Override app root (defaults to cwd) |
