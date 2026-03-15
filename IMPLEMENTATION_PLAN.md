# Craft Agents Web — Implementation Plan (MVP)

## Executive Summary

Deploy Craft Agents as a **web app for a small team (~20 users)**. No multi-tenant auth, no database, no horizontal scaling. Just the existing server + a browser frontend that connects via the same WebSocket RPC protocol the desktop app uses.

**What we're keeping simple:**
- Single `CRAFT_SERVER_TOKEN` for auth (same as headless server mode)
- File-based storage (already works, no database needed for 20 users)
- Server-managed Anthropic API key (one key for all users)
- No user registration/login — token-based access only

---

## Target Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Web Client (apps/web — Vite + React)                     │
│  ├── WsRpcClient (browser WebSocket, same protocol)       │
│  ├── WebAPI adapter (replaces window.electronAPI)         │
│  ├── packages/ui components (reused directly)             │
│  └── Electron-specific stubs (shell:open → window.open)   │
├──────────────────────────────────────────────────────────│
│  Nginx / Caddy (reverse proxy)                            │
│  ├── Serves static web client files                       │
│  ├── Proxies /ws → server WebSocket                       │
│  └── TLS termination (HTTPS + WSS)                        │
├──────────────────────────────────────────────────────────│
│  Server (packages/server — UNCHANGED)                     │
│  ├── WsRpcServer on port 9100                             │
│  ├── CRAFT_SERVER_TOKEN auth                              │
│  ├── Single workspace (shared by all users)               │
│  └── ANTHROPIC_API_KEY from environment                   │
├──────────────────────────────────────────────────────────│
│  Persistent Volume                                        │
│  └── ~/.craft-agent/ (configs, sessions, sources)         │
└──────────────────────────────────────────────────────────┘
```

**Key simplification**: All users share one workspace and one server token. This is functionally identical to the desktop app's headless server mode with multiple clients connecting.

---

## What We're NOT Building (For Now)

| Feature | Why Not |
|---------|---------|
| User registration/login | Token-based access for 20 people is sufficient |
| PostgreSQL database | File-based storage handles 20 users fine |
| Redis | No need for caching/rate limiting at this scale |
| JWT auth system | CRAFT_SERVER_TOKEN works |
| Rate limiting / credits | Trust the team, monitor Anthropic usage dashboard |
| Horizontal scaling | Single server instance is enough |
| Admin dashboard | Check Anthropic dashboard for usage |

---

## Sources Feature — No Changes Needed

The Sources feature works entirely through the agent (Claude). The flow is:
1. User says "add Hubspot as a source" in chat
2. Agent searches for API docs, creates source folder, writes `guide.md`
3. Agent sets up auth via `source_credential_prompt` tool
4. Done — source is available in future sessions

This is all server-side logic that doesn't change between desktop and web. The only UI work is porting the source management components (list, info page, selector).

**One exception**: OAuth-based sources (Google, Slack, Microsoft) need server-side redirect handling since there's no local callback server in a web browser. This is the single biggest backend change.

---

## Implementation — 3 Workstreams

### WORKSTREAM 1: Web Client (Frontend)

**Goal**: `apps/web/` — Vite+React app connecting to the existing server via WebSocket.

#### Task 1.1 — Bootstrap
- Create `apps/web/` with Vite + React 18 + Tailwind v4
- Configure monorepo resolution for `packages/ui` and `packages/shared` types
- Entry: `main.tsx` → `App.tsx`

#### Task 1.2 — Browser WebSocket Client
Port `apps/electron/src/transport/client.ts` to browser:
- Replace `ws` npm package with native browser `WebSocket`
- Reuse `build-api.ts` and `channel-map.ts` as-is
- Create `WebAPI` matching the `ElectronAPI` interface shape

**Electron stubs needed:**

| Desktop Feature | Web Replacement |
|----------------|-----------------|
| `shell.openExternal(url)` | `window.open(url, '_blank')` |
| `shell.showItemInFolder(path)` | No-op or "Copy path" button |
| `dialog.showMessageBox` | Browser `confirm()` or modal |
| `dialog.showOpenDialog` | `<input type="file">` wrapper |
| `ipcRenderer.sendSync` | Config from initial HTTP response or env |
| Traffic lights | Standard browser chrome |
| `performOAuth` (local callback) | Server-side redirect (see Workstream 2) |

#### Task 1.3 — App Shell
Port these components from `apps/electron/src/renderer/`:
- `AppShell.tsx` — main layout (sidebar + content)
- `LeftSidebar.tsx` — navigation
- `NavigationContext.tsx` — adapt custom routing for web (use `pushState`)
- `TopBar.tsx` — remove Electron-specific controls
- `ThemeContext.tsx` — theme system

#### Task 1.4 — Chat Interface
Port in this order:
1. `event-processor/` — streaming event handling (critical for real-time updates)
2. `ChatPage.tsx` + `ChatDisplay.tsx` — chat layout
3. `SessionViewer.tsx` from `packages/ui` — already pure React
4. `TurnCard.tsx` from `packages/ui` — message rendering
5. `FreeFormInput.tsx` — message input with @mentions
6. `InputContainer.tsx` — wraps input with permission/credential requests
7. `AuthRequestCard.tsx` — credential prompts in chat

**Critical pattern**: `sendMessage` returns immediately. Subscribe to `session:event` channel BEFORE sending, then process streaming events (`text_delta`, `tool_start`, `tool_result`, `complete`).

#### Task 1.5 — Sources UI
Port:
- `SourcesListPanel.tsx` — source list with type/status badges
- `SourceInfoPage.tsx` — source details, guide.md display
- `SourceSelectorPopover.tsx` — source picker in chat input
- `SourceAvatar.tsx`, `source-status-indicator.tsx`
- `SourceMenu.tsx` — adapt actions for web (remove "Show in Finder")
- `AuthRequestCard.tsx` + `CredentialRequest.tsx` — auth flows in chat
- **Remove** local source type from UI (not possible in web)

#### Task 1.6 — Session Management
Port:
- Session list with search/filter
- Session creation
- Session status/flag/archive controls
- `sessions.ts` atoms (Jotai state)

#### Task 1.7 — Remaining Features
- Skills list and info page
- Settings page (simplified — no LLM connection management)
- Keyboard shortcuts
- File attachments (via `<input type="file">` → upload to server)
- Reconnection UX (handle WebSocket disconnects)

#### Files to Port (Priority Order)
1. `apps/electron/src/transport/client.ts` → browser WsRpcClient
2. `apps/electron/src/transport/build-api.ts` → reuse as-is
3. `apps/electron/src/transport/channel-map.ts` → reuse, filter unsupported
4. `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
5. `apps/electron/src/renderer/contexts/NavigationContext.tsx`
6. `apps/electron/src/renderer/event-processor/` → streaming events
7. `apps/electron/src/renderer/pages/ChatPage.tsx`
8. `apps/electron/src/renderer/atoms/sessions.ts`
9. `apps/electron/src/renderer/components/app-shell/SourcesListPanel.tsx`
10. `apps/electron/src/renderer/pages/SourceInfoPage.tsx`

---

### WORKSTREAM 2: Backend Adaptation

**Goal**: Minimal server changes to support web clients. The server already works — we only need to fix OAuth and file uploads.

#### Task 2.1 — Server-Side OAuth Redirect Handler
**This is the single biggest backend change.**

Currently: Desktop app runs a local HTTP callback server → OAuth provider redirects to `localhost:PORT/oauth/callback` → desktop exchanges code for tokens.

For web: No local server. We need the OAuth provider to redirect to our web server.

**Implementation:**
- Add HTTP route to the server: `GET /oauth/callback`
- On redirect, server:
  1. Validates `state` parameter against `OAuthFlowStore`
  2. Exchanges code for tokens (same logic as desktop `performOAuth`)
  3. Stores credentials via `CredentialManager`
  4. Returns HTML that posts a message to the opener window and closes itself
- Modify `oauth:start` RPC handler to use server's public URL as redirect URI
- Modify client: `performOAuth` opens popup to auth URL, waits for `postMessage` from callback page

**Files to modify:**
- `packages/server-core/src/transport/server.ts` — add HTTP route for `/oauth/callback`
- `packages/server-core/src/handlers/rpc/oauth.ts` — adapt redirect URI generation
- New: callback HTML page that communicates back to opener via `postMessage`

#### Task 2.2 — File Upload Endpoint
For web file attachments (drag-drop PDFs, images):
- Add `POST /upload` HTTP endpoint to the server
- Store files in session's attachments directory
- Return file reference for the chat message
- Existing `file:storeAttachment` RPC handles the rest

#### Task 2.3 — Headless Server Adjustments
- Ensure `headless-start.ts` auto-creates default workspace with Anthropic connection from `ANTHROPIC_API_KEY` env var (this was already done in previous attempt)
- Force `allow-all` permission mode for web sessions (no interactive approval UI yet), OR implement permission approval in the web UI
- Set `CRAFT_BUNDLED_ASSETS_ROOT` to point to `apps/electron` for config-defaults.json

#### Task 2.4 — Disable Desktop-Only Features
Return no-op/stubs for channels that don't make sense in web:
- `browserPane:*` — Electron BrowserView
- `shell:showInFolder` — no filesystem access
- `dialog:openFolder` — use file upload instead
- `update:*` — no auto-update
- `window:close`, `window:setTrafficLights` — no Electron window

---

### WORKSTREAM 3: Infrastructure

**Goal**: Docker setup for local dev and production deployment.

#### Task 3.1 — Dockerfiles
**`Dockerfile.server`** (Server container):
```
FROM oven/bun:latest
# Install Python 3 + uv for document tools
# Copy monorepo, bun install --ignore-scripts
# Set CRAFT_BUNDLED_ASSETS_ROOT=/app/apps/electron
# Set CRAFT_IS_PACKAGED=false
# Pre-create /data/craft-agent
# ENTRYPOINT: bun run packages/server/src/index.ts
```

**`Dockerfile.web`** (Static web client):
```
FROM node:20 AS build
# Copy monorepo, build apps/web
FROM nginx:alpine
# Copy built static files
# nginx.conf with /ws proxy to server
```

Learnings from previous attempt to apply:
- Use `--ignore-scripts` for bun install (husky fails without git)
- Health endpoint already exists on server
- `CRAFT_BUNDLED_ASSETS_ROOT` must point to `apps/electron`
- Pre-create config directories

#### Task 3.2 — Docker Compose
```yaml
services:
  server:
    build: { dockerfile: Dockerfile.server }
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - CRAFT_SERVER_TOKEN=${CRAFT_SERVER_TOKEN}
      - CRAFT_RPC_HOST=0.0.0.0
      - PORT=9100
    volumes:
      - craft-data:/data/craft-agent
    ports:
      - "9100:9100"

  web:
    build: { dockerfile: Dockerfile.web }
    ports:
      - "3000:80"
    depends_on:
      - server
```

#### Task 3.3 — Production Deployment
- Deploy to Railway / Fly.io (single machine is fine for 20 users)
- Set environment variables
- Persistent volume for `~/.craft-agent/`
- TLS via platform or Caddy reverse proxy

#### Environment Variables
| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claude API access |
| `CRAFT_SERVER_TOKEN` | Yes | Auth token for WS connections |
| `PORT` | Auto | Server listen port |
| `CRAFT_BUNDLED_ASSETS_ROOT` | Yes | Path to config defaults |
| `OAUTH_REDIRECT_BASE_URL` | For OAuth sources | Public URL for OAuth callbacks |
| `GOOGLE_OAUTH_CLIENT_ID` | For Google sources | Google OAuth |
| `SLACK_OAUTH_CLIENT_ID` | For Slack sources | Slack OAuth |

---

## Implementation Order

```
Week 1: Foundation
├── 1.1 Bootstrap web app
├── 1.2 Browser WS client + WebAPI adapter
├── 1.3 App shell (layout renders)
├── 3.1 Dockerfiles (parallel)
└── 2.3 Headless server adjustments (parallel)

Week 2: Chat Works
├── 1.4 Chat interface (send messages, see streaming responses)
├── 1.6 Session management (create, list, switch)
├── 2.4 Disable desktop-only features
└── 3.2 Docker compose (local dev working)

Week 3: Sources & Polish
├── 1.5 Sources UI (list, info, selector)
├── 2.1 Server-side OAuth redirect (for Google/Slack/Microsoft sources)
├── 2.2 File upload endpoint
├── 1.7 Remaining features (skills, settings, shortcuts)
└── 3.3 Production deployment
```

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| **OAuth redirect in web** | High — blocks Google/Slack/Microsoft sources | Do a spike in Week 1 to validate approach. Bearer/API key sources work without this. |
| **Claude Agent SDK stdout buffering in Docker** | High — agent hangs | Use `stdbuf -oL`, test in Docker early |
| **WebSocket disconnects** | Medium — poor UX | Auto-reconnect already in WsRpcClient, add UI indicator |
| **Concurrent users on same workspace** | Low — possible race conditions | File writes are atomic (temp+rename). 20 users is fine. |
| **Large system prompts from many sources** | Low — token waste | Source guide summarization exists in codebase |

---

## Summary

This is a **3-week project** with the following effort split:

| Workstream | Effort | Description |
|-----------|--------|-------------|
| Frontend | ~60% | Port Electron renderer to browser, build WebAPI adapter |
| Backend | ~20% | OAuth redirect handler, file upload, server stubs |
| Infrastructure | ~20% | Docker, deployment, env config |

The key insight: **the server already works as a headless WebSocket RPC service**. We're just building a new client that speaks the same protocol. The Sources feature needs zero backend changes — it's entirely agent-driven.
