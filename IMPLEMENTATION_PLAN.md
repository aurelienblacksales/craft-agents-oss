# Craft Agents Web — Implementation Plan

## Executive Summary

This plan transforms the Craft Agents desktop app (Electron) into a multi-tenant web application, replicating all features — especially **Sources** (the ability to paste API documentation and create connectors). The architecture reuses the existing server (`packages/server` + `packages/server-core`) and shared logic (`packages/shared`), replacing only the Electron shell with a browser-based frontend.

---

## Current Architecture (As-Is)

```
┌──────────────────────────────────────────────────────┐
│  Electron App (apps/electron)                         │
│  ├── Main Process: boots server-core, manages windows │
│  ├── Preload: WsRpcClient → builds ElectronAPI proxy  │
│  └── Renderer: React UI (packages/ui + renderer/)     │
│       ├── Jotai atoms for state (sessions, sources)   │
│       ├── window.electronAPI.* for all RPC calls      │
│       └── Tailwind v4 + shadcn/ui components          │
├──────────────────────────────────────────────────────│
│  Server (packages/server + server-core)               │
│  ├── WsRpcServer (WebSocket RPC, JSON envelopes)      │
│  ├── 15 RPC handler modules (sessions, sources, etc.) │
│  ├── SessionManager (agent lifecycle)                 │
│  └── Push events (session:event, sources:changed...)  │
├──────────────────────────────────────────────────────│
│  Shared (packages/shared)                             │
│  ├── Sources: CRUD, SourceServerBuilder, credentials  │
│  ├── Agent: CraftAgent (wraps Claude Agent SDK)       │
│  ├── Config: file-based JSON, ~/.craft-agent/         │
│  ├── Credentials: AES-256-GCM encrypted file          │
│  ├── Sessions: JSONL persistence                      │
│  └── MCP: client pool, proxy servers                  │
└──────────────────────────────────────────────────────┘
```

**Key insight**: The desktop app already uses WebSocket RPC between renderer and server (via `WsRpcClient` in preload). The web version can connect to the same WS server directly. The `CHANNEL_MAP` (334 entries) defines every API call — this IS our web API.

---

## Target Architecture (To-Be)

```
┌─────────────────────────────────────────────────────────────────┐
│  Web Client (apps/web — Vite + React)                            │
│  ├── WsRpcClient (browser WebSocket, same protocol)              │
│  ├── WebAPI adapter (replaces window.electronAPI)                │
│  ├── packages/ui components (reused directly)                    │
│  ├── Electron-specific stubs (shell:openUrl → window.open, etc.) │
│  └── Auth layer: login page → JWT → WS token                    │
├─────────────────────────────────────────────────────────────────│
│  API Gateway / Auth Service (new)                                │
│  ├── HTTP: /auth/login, /auth/register, /oauth/callback         │
│  ├── JWT issuance + validation                                   │
│  ├── Maps user → workspace → server token                       │
│  └── Reverse proxy: WS upgrade with injected auth               │
├─────────────────────────────────────────────────────────────────│
│  Server (packages/server + server-core — MOSTLY UNCHANGED)       │
│  ├── Multi-workspace support already built in                    │
│  ├── Each user gets their own workspace                          │
│  ├── Token auth already supported (CRAFT_SERVER_TOKEN)           │
│  └── Health endpoint already added (from previous work)          │
├─────────────────────────────────────────────────────────────────│
│  Database (NEW — replaces file-based storage for multi-tenant)   │
│  ├── PostgreSQL: users, workspaces, sessions metadata            │
│  ├── File storage stays for: session JSONL, source configs       │
│  └── Credentials: encrypted in DB (migrate from .enc file)       │
├─────────────────────────────────────────────────────────────────│
│  Infrastructure                                                  │
│  ├── Railway / Fly.io / AWS ECS                                  │
│  ├── Persistent volumes for workspace files                      │
│  └── Redis: session cache, rate limiting, pub/sub               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Architectural Decisions

### 1. Reuse vs. Rebuild

**Decision: Maximum reuse.** The server already speaks WebSocket RPC. The UI components (`packages/ui`) are framework-level React — no Electron dependencies. The renderer code (`apps/electron/src/renderer/`) is 90% reusable; only the Electron-specific bits (preload bridge, shell commands, native dialogs) need web adapters.

### 2. Multi-Tenancy Strategy

**Decision: Workspace-per-user isolation.** The app already has the concept of workspaces with isolated configs, sources, skills, and sessions. Each web user gets a workspace. The server already supports multiple workspaces.

**Risk**: The current storage is file-based (`~/.craft-agent/workspaces/{id}/`). For multi-tenant web, we need either:
- (a) Separate file directories per user on persistent volume (simpler, works for <1000 users)
- (b) Full database migration (required for scale)

**Recommendation**: Start with (a) for MVP, plan for (b).

### 3. OAuth in Web vs. Desktop

**Critical difference**: The desktop app runs a local callback server (`createCallbackServer`) for OAuth redirects. In a web app, there IS no local server — the browser gets the redirect directly.

**Decision**: Implement server-side OAuth redirect handling. The auth flow becomes:
1. Web client calls `oauth:start` → server returns `authUrl`
2. Client opens authUrl in new tab/popup
3. OAuth provider redirects to our web server's callback endpoint (`/oauth/callback`)
4. Server exchanges code for tokens, stores credentials
5. Server pushes success event to client via WebSocket

This requires a new HTTP endpoint on the server for OAuth callbacks.

### 4. LLM Connection Strategy

**Decision: Server-managed Anthropic key.** Instead of each user providing their own API key (desktop model), the web app uses a shared Anthropic API key managed by the operator. Users don't see or manage LLM connections — that's an admin concern.

**Credits/billing**: Implement usage tracking per user, with rate limits.

---

## Sources Feature — Deep Analysis

Sources are the core differentiator. Here's exactly how they work:

### Source Types
| Type | Storage | Runtime |
|------|---------|---------|
| **MCP** | `config.json` with `mcp.url` or `mcp.command` | MCP client connects, tools are proxied to Claude |
| **API** | `config.json` with `api.baseUrl`, `api.authType` | Dynamic REST tools generated by `api-tools.ts` |
| **Local** | `config.json` with `local.path` | Filesystem access (NOT relevant for web) |

### Source Files (per source)
```
~/.craft-agent/workspaces/{id}/sources/{slug}/
├── config.json    — FolderSourceConfig (type, auth, endpoints)
├── guide.md       — Usage documentation (agent reads this for context)
└── icon.svg/png   — Brand icon
```

### How Sources Work at Runtime
1. **Source creation**: Agent (or user) creates a source via `createSource()`
2. **guide.md**: The agent writes API documentation here. This is what gets injected into the system prompt as context. Sections: Scope, Guidelines, Context, API Notes
3. **SourceManager**: Tracks active/inactive sources per session. Formats source state for system prompt injection
4. **SourceServerBuilder**: Builds MCP server configs or API tool definitions from source configs
5. **McpClientPool**: Centralized pool manages all source connections (both MCP and API)
6. **Context injection**: Active source guides are injected into the system prompt so Claude knows how to use each API

### What "Paste API Documentation" Actually Does
When a user tells the agent "add Linear as a source":
1. The agent searches for Linear's API documentation (via `craft-agents-docs` built-in source or web)
2. Creates a source folder with `config.json` (type, base URL, auth type)
3. Writes API documentation into `guide.md`
4. The guide.md becomes part of the agent's context in future conversations
5. The agent can then use API tools or MCP tools to interact with the service

### Web Adaptation Required
- **MCP stdio sources**: NOT possible in web (they spawn local subprocesses). Must be server-side only.
- **MCP HTTP/SSE sources**: Work fine — server connects to remote MCP servers.
- **API sources**: Work fine — server makes HTTP requests.
- **Local sources**: NOT possible in web. Remove from UI.
- **OAuth for sources**: Needs server-side redirect handling (see Decision #3 above).

---

## Implementation Phases

### Phase 0: Foundation (Week 1)
**Goal**: Web client connects to server, renders the chat UI, can send/receive messages.

### Phase 1: Sources MVP (Weeks 2-3)
**Goal**: Users can add API sources (paste documentation), authenticate, and use them in conversations.

### Phase 2: Multi-User & Auth (Weeks 3-4)
**Goal**: User registration, login, workspace isolation, API key management.

### Phase 3: Polish & Scale (Weeks 5-6)
**Goal**: Credits/usage tracking, rate limiting, admin dashboard, production deployment.

---

## Team Assignments

---

### TEAM 1: Frontend (Web Client)

**Scope**: Build `apps/web/` — a Vite+React web client that connects to the existing server via WebSocket RPC.

#### Architecture
- **Framework**: Vite + React 18 + Tailwind v4 (same as desktop)
- **State**: Jotai (same as desktop)
- **Components**: Import directly from `packages/ui` (already pure React)
- **RPC**: Port `WsRpcClient` from `apps/electron/src/transport/client.ts` to work in browser (replace `ws` npm with native `WebSocket`)
- **API Layer**: Create `WebAPI` adapter that matches the `ElectronAPI` interface shape, backed by `WsRpcClient` + `CHANNEL_MAP`

#### Key Tasks

**T1.1 — Bootstrap web app**
- Create `apps/web/` with Vite config
- Set up Tailwind v4, import `packages/ui` styles
- Configure monorepo path resolution (shared types, ui components)
- Entry point: `main.tsx` → `App.tsx`

**T1.2 — Browser WebSocket RPC client**
- Port `apps/electron/src/transport/client.ts` to use browser `WebSocket` instead of `ws` npm
- Port `build-api.ts` and `channel-map.ts` (reuse directly)
- Create `WebAPI` that matches `ElectronAPI` interface
- Electron-specific stubs:
  - `shell:openUrl` → `window.open(url, '_blank')`
  - `shell:showInFolder` → no-op or download link
  - `file:openDialog` → `<input type="file">` wrapper
  - `window:close` → no-op
  - `dialog:showMessageBox` → browser confirm/modal

**T1.3 — App shell (layout)**
- Port `AppShell.tsx` (main layout: sidebar + content + panels)
- Port `LeftSidebar.tsx` (workspace nav, session list, sources list)
- Port `NavigationContext.tsx` (URL-based routing instead of in-memory)
- Port `TopBar.tsx` (remove Electron traffic lights, add web navigation)
- Implement React Router for page navigation (replace Electron in-memory navigation)

**T1.4 — Chat interface**
- Port `ChatPage.tsx`, `ChatDisplay.tsx`, `SessionViewer.tsx`
- Port `FreeFormInput.tsx` (message input with @mentions)
- Port `TurnCard.tsx` (message rendering with tool visualizations)
- Port `InlineExecution.tsx` (tool execution display)
- Port event processor (`event-processor/`) for streaming updates

**T1.5 — Sources UI**
- Port `SourcesListPanel.tsx` (source list with type badges, status indicators)
- Port `SourceInfoPage.tsx` (source details, guide.md display, permissions)
- Port `SourceMenu.tsx` (delete, open — adapt for web)
- Port `SourceSelectorPopover.tsx` (source picker in chat)
- Port `SourceAvatar.tsx`, `source-status-indicator.tsx`
- Port `EditPopover.tsx` for source editing
- Port `AuthRequestCard.tsx` (credential prompts in chat)
- Port `CredentialRequest.tsx` (structured credential input)
- **Remove**: Local source type from creation UI
- **Adapt**: OAuth trigger to use server-side redirect (no local callback server)

**T1.6 — Settings & configuration pages**
- Port `WorkspaceSettingsPage.tsx`
- Port `SettingsNavigator.tsx`
- Simplify LLM connection UI (server-managed key — show status only, not key input)
- Port theme system (`ThemeContext.tsx`)

**T1.7 — Auth pages (web-specific)**
- Login page
- Registration page
- Password reset
- JWT token management (store in httpOnly cookie or localStorage)
- Reconnection UX (handle WebSocket disconnects gracefully)

#### Electron Adaptation Checklist
The renderer code has these Electron dependencies that need web alternatives:

| Electron Feature | Web Alternative |
|-----------------|-----------------|
| `window.electronAPI.*` | `WebAPI` adapter via WsRpcClient |
| `shell.openExternal(url)` | `window.open(url, '_blank')` |
| `shell.showItemInFolder(path)` | No-op or "Copy path" |
| `dialog.showMessageBox` | Browser `confirm()` or modal component |
| `dialog.showOpenDialog` | `<input type="file">` |
| `ipcRenderer.sendSync` | Initial HTTP request for config |
| `contextBridge` | Direct module import |
| Traffic lights (macOS) | Standard browser chrome |
| `Cmd+N` shortcuts | Same, but with web keybinding |
| `performOAuth` (local callback server) | Server-side redirect handler |
| Notification API (Electron) | Web Notification API |
| `app.getPath('userData')` | N/A — server manages storage |

#### Critical Files to Port
Priority ordering — get these working first:
1. `apps/electron/src/transport/client.ts` → browser WsRpcClient
2. `apps/electron/src/transport/build-api.ts` → reuse as-is
3. `apps/electron/src/transport/channel-map.ts` → reuse as-is (filter unsupported channels)
4. `apps/electron/src/renderer/components/app-shell/AppShell.tsx` → main layout
5. `apps/electron/src/renderer/contexts/NavigationContext.tsx` → adapt for web routing
6. `apps/electron/src/renderer/pages/ChatPage.tsx` → chat view
7. `apps/electron/src/renderer/event-processor/` → streaming event handling
8. `apps/electron/src/renderer/components/app-shell/SourcesListPanel.tsx` → sources list
9. `apps/electron/src/renderer/pages/SourceInfoPage.tsx` → source details

---

### TEAM 2: Backend Adaptation

**Scope**: Adapt the existing server for web multi-tenant operation. Minimal changes — the server already works as WebSocket RPC.

#### Key Tasks

**T2.1 — Server-side OAuth redirect handler**
This is the biggest backend change. Currently, OAuth flows use a local callback server in the Electron app. For web:

- Add HTTP routes to the server: `GET /oauth/callback` and `GET /oauth/callback/:provider`
- When the OAuth provider redirects here, the server:
  1. Validates the `state` parameter against the flow store
  2. Exchanges the authorization code for tokens
  3. Stores credentials in the credential manager
  4. Pushes success/failure event to the client via WebSocket
  5. Returns an HTML page that closes itself / redirects back to the app

**Files to modify**:
- `packages/server-core/src/handlers/rpc/oauth.ts` — adapt `oauth:start` to generate redirect URL pointing to our server
- `packages/server-core/src/transport/server.ts` — add HTTP route handling for `/oauth/callback`
- `packages/shared/src/auth/callback-server.ts` — study the flow, replicate server-side

**T2.2 — Multi-user workspace management**
- Auto-create workspace on user registration
- Map user ID → workspace ID
- Ensure workspace isolation (user A can't access user B's workspace)
- Pre-configure the Anthropic connection with server's API key

**Files to modify**:
- `packages/server-core/src/bootstrap/headless-start.ts` — extend for multi-user
- `packages/server-core/src/handlers/rpc/workspace.ts` — add user context validation

**T2.3 — Auth middleware for WebSocket**
- The server already has `validateToken` support in `WsRpcServer`
- Extend to validate JWTs instead of static tokens
- Extract user ID from JWT, map to workspace
- Inject workspace context into `RequestContext`

**Files to modify**:
- `packages/server-core/src/transport/server.ts` — JWT validation in handshake
- `packages/server-core/src/transport/types.ts` — add userId to RequestContext

**T2.4 — HTTP auth endpoints**
- Add REST endpoints alongside WebSocket:
  - `POST /auth/register` — create user + workspace
  - `POST /auth/login` — validate credentials, return JWT
  - `POST /auth/refresh` — refresh JWT
  - `GET /auth/me` — return user info
- These can live in a new `packages/auth-service/` or in the existing server

**T2.5 — Disable desktop-only features in web mode**
- `browserPane:*` channels — Electron BrowserView, not available in web
- `shell:showInFolder` — return no-op
- `dialog:openFolder` — return stub
- `file:openDialog` — needs web file upload adapter
- Local MCP (stdio) sources — keep server-side execution but mark as "admin-only"
- App updates (`update:*`) — not applicable

**T2.6 — Source guide.md creation via agent**
The "paste API documentation" flow works like this:
1. User says "add Hubspot as a source" in chat
2. Agent uses tools to search for API docs (via built-in `craft-agents-docs` MCP)
3. Agent calls `source_create` tool (session-scoped tool)
4. Agent writes the API documentation into `guide.md`
5. Agent may set up credentials via `source_credential_prompt` tool

This flow already works server-side and needs **NO backend changes**. The agent creates sources via the same tool calls regardless of whether the frontend is Electron or web.

**T2.7 — File upload endpoint**
For web file attachments (drag-drop PDFs, images):
- Add `POST /upload` HTTP endpoint
- Store files in workspace's attachments directory
- Return file reference for the chat message
- The existing `file:storeAttachment` RPC channel needs an HTTP adapter

---

### TEAM 3: Infrastructure & DevOps

**Scope**: Containerization, deployment, persistent storage, monitoring.

#### Key Tasks

**T3.1 — Docker setup**
- `Dockerfile.server` — Server + auth service (Bun + Python 3 for document tools)
- `Dockerfile.web` — Static build served by nginx/caddy
- `docker-compose.yml` — Full local dev setup with postgres, redis, server, web
- Use learnings from previous attempt:
  - `--ignore-scripts` for bun install
  - Health endpoint already on server
  - `CRAFT_BUNDLED_ASSETS_ROOT` must point to `apps/electron` (for config-defaults.json)
  - Pre-create `/data/craft-agent` directory

**T3.2 — Database setup (PostgreSQL)**
For MVP with file-based storage, Postgres is needed only for:
- User accounts (email, hashed password, workspace_id)
- Usage tracking (API calls per user, token counts)
- Session metadata index (for faster listing)

Schema:
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  credits_used INTEGER DEFAULT 0,
  credits_limit INTEGER DEFAULT 10000
);

CREATE TABLE usage_log (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  session_id TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**T3.3 — Persistent volume strategy**
Each user's workspace files (`~/.craft-agent/workspaces/{id}/`) need persistent storage:
- **Option A**: Single persistent volume, user directories as subdirectories
- **Option B**: Object storage (S3) for source configs and guides
- **Recommendation**: Option A for MVP, with daily backups

**T3.4 — Redis for session state**
- WebSocket session mapping (which server instance handles which user)
- Rate limiting per user
- Pub/sub for multi-instance push events (if scaling horizontally)

**T3.5 — Deployment pipeline**
- GitHub Actions for CI/CD
- Staging environment for testing
- Production on Railway / Fly.io / AWS ECS
- Environment variables management (see table below)

**T3.6 — Monitoring & logging**
- Health endpoint: already implemented
- Structured logging: extend existing debug system
- Error tracking: Sentry (already in codebase)
- Usage dashboards: Grafana + Postgres queries

#### Environment Variables (Production)
| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Shared Claude API key |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | JWT signing secret |
| `PORT` | HTTP/WS port (Railway auto-assigns) |
| `CRAFT_BUNDLED_ASSETS_ROOT` | Path to config defaults |
| `CRAFT_IS_PACKAGED` | `false` |
| `OAUTH_REDIRECT_BASE_URL` | Public URL for OAuth callbacks |
| `GOOGLE_OAUTH_CLIENT_ID` | For Google source OAuth |
| `GOOGLE_OAUTH_CLIENT_SECRET` | For Google source OAuth |
| `SLACK_OAUTH_CLIENT_ID` | For Slack source OAuth |
| `SLACK_OAUTH_CLIENT_SECRET` | For Slack source OAuth |
| `MICROSOFT_OAUTH_CLIENT_ID` | For Microsoft source OAuth |

---

### TEAM 4: Security & Auth

**Scope**: User authentication, authorization, credential security, rate limiting.

#### Key Tasks

**T4.1 — User authentication system**
- Registration: email + password (bcrypt hash)
- Login: email + password → JWT (short-lived access + longer refresh token)
- JWT contains: `{ userId, workspaceId, email, exp }`
- Refresh token rotation
- Consider adding OAuth login (Sign in with Google) for convenience

**T4.2 — WebSocket authentication**
- On WS connect: client sends JWT in first message (handshake)
- Server validates JWT, extracts userId and workspaceId
- All subsequent RPC calls are scoped to that workspace
- On JWT expiry: client refreshes via HTTP, reconnects WS

**T4.3 — Workspace isolation**
- Every RPC handler must validate that the requested workspaceId matches the authenticated user's workspace
- Existing handlers take `workspaceId` as parameter — add middleware that overrides this with the auth context
- This prevents user A from accessing user B's sources/sessions

**T4.4 — Credential security for web**
- The desktop app uses AES-256-GCM encrypted file (`credentials.enc`) with a machine-derived key
- For web: encrypt credentials with a server-managed key (not user-derived)
- The `CredentialManager` interface is already abstracted — implement a database-backed variant
- Never expose API keys/tokens to the frontend

**T4.5 — Rate limiting & credits**
- Per-user rate limits on:
  - Messages per minute (prevent abuse)
  - API source calls per hour
  - Total tokens per day/month
- Track usage in PostgreSQL
- Return `429 Too Many Requests` when limits hit
- Admin endpoint to adjust user limits

**T4.6 — Input sanitization**
- Source names and slugs: already validated via `generateSourceSlug()`
- Guide.md content: sanitize before rendering in frontend (XSS prevention)
- File uploads: validate file types, scan for malware
- RPC message size limits

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| **OAuth redirect in web** | High — core feature blocked | Phase 0 spike to validate server-side redirect flow |
| **Claude Agent SDK stdout buffering in Docker** | High — agent hangs | Use `stdbuf -oL`, test early in Docker |
| **File-based storage at scale** | Medium — performance degrades >1000 users | Design DB migration path from day 1 |
| **MCP stdio sources** | Medium — can't run local servers in web | Server-side only; admin manages stdio sources |
| **Session memory with many sources** | Medium — large system prompts | Implement source guide summarization for large guides |
| **WebSocket disconnects** | Medium — poor UX | Auto-reconnect with exponential backoff (already in WsRpcClient) |
| **Multi-instance deployment** | Medium — push events don't reach all clients | Redis pub/sub for cross-instance events |
| **Credential leakage** | High — security breach | Never send credentials to frontend; server-side only |

---

## Phase 0 Checklist (First Working Demo)

1. [ ] `apps/web/` bootstrapped with Vite + React + Tailwind v4
2. [ ] Browser WsRpcClient connects to server
3. [ ] WebAPI adapter created, matching ElectronAPI shape
4. [ ] `AppShell` renders with sidebar + chat panel
5. [ ] Can create a session and send a message
6. [ ] Streaming responses render in real-time
7. [ ] Tool execution displays in TurnCard
8. [ ] Sources list loads and displays
9. [ ] Can navigate to source info page
10. [ ] Docker compose: server + web + postgres running locally

---

## Dependency Graph

```
Phase 0 (Foundation)
├── T1.1 Bootstrap web app
├── T1.2 Browser WS client ← depends on understanding transport/client.ts
├── T1.3 App shell ← depends on T1.2
├── T1.4 Chat interface ← depends on T1.3
├── T3.1 Docker setup (parallel)
└── T2.5 Disable desktop-only features (parallel)

Phase 1 (Sources MVP)
├── T1.5 Sources UI ← depends on Phase 0
├── T2.1 Server-side OAuth ← depends on T2.5
├── T2.6 Source guide.md creation (NO CHANGES NEEDED — agent does this)
└── T4.4 Credential security ← depends on T2.1

Phase 2 (Multi-User)
├── T2.4 HTTP auth endpoints
├── T2.2 Multi-user workspace management ← depends on T2.4
├── T2.3 Auth middleware for WS ← depends on T2.4
├── T4.1 User auth system ← depends on T2.4
├── T4.2 WebSocket auth ← depends on T4.1
├── T4.3 Workspace isolation ← depends on T4.2
├── T3.2 Database setup (parallel with T2.4)
└── T1.7 Auth pages ← depends on T2.4

Phase 3 (Polish & Scale)
├── T4.5 Rate limiting & credits
├── T3.4 Redis
├── T3.5 Deployment pipeline
├── T3.6 Monitoring
└── T1.6 Settings pages
```

---

## Questions for Clarification

1. **Hosting preference**: Railway (previous attempt), Fly.io, or AWS? This affects the infra approach.
2. **User management**: Do you want self-registration or invite-only for your sales/GTM users?
3. **Pre-configured sources**: Since your users are sales/GTM, should the app come with pre-configured sources (Hubspot, Salesforce, Apollo, etc.) or should each user set them up via the agent?
4. **Local MCP sources**: Since web can't run local MCP servers, do you need admin-managed shared MCP sources?
5. **White-labeling**: Should the UI be re-brandable (your logo, colors, domain)?
6. **Concurrent users target**: This affects whether we need Redis/horizontal scaling from day 1 or can start simpler.

---

## Summary

The good news: **80% of the work is already done**. The server, agent, sources system, and most UI components are ready. The main work is:

1. **Browser WS client + Electron adapter** (~30% of effort) — replacing Electron-specific APIs with web equivalents
2. **Server-side OAuth** (~20%) — the one truly new backend feature
3. **Auth & multi-tenancy** (~25%) — user management, JWT, workspace isolation
4. **Infrastructure** (~15%) — Docker, deploy, monitoring
5. **Polish & credits** (~10%) — rate limiting, usage tracking, UX refinements

The Sources feature specifically requires almost no backend changes — it's agent-driven (the LLM creates sources via tools), and the UI is standard React that can be ported directly.
