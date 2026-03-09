# Analysis: Building a Web-Based Version of Craft Agents

## Feasibility: YES — The Architecture Is Already Web-Ready

The codebase has a **clean client-server separation** that makes a web version highly feasible.

## What Already Exists (Reusable As-Is)

| Component | Package | Notes |
|-----------|---------|-------|
| **Headless server** | `packages/server-core/` + `packages/server/` | Full agent execution server, already supports remote WebSocket clients with token auth |
| **React UI components** | `packages/ui/` | `SessionViewer`, `TurnCard`, overlays — pure React, no Electron deps |
| **Session viewer web app** | `apps/viewer/` | Already a working Vite+React web app using `@craft-agent/ui` |
| **WebSocket RPC protocol** | `packages/server-core/src/transport/` | Full bidirectional RPC with handshake, heartbeat, auth, push events |
| **CLI remote client** | `apps/cli/` | Proves the server works with non-Electron clients |
| **Core types** | `packages/core/` | Pure TypeScript types, fully portable |
| **Business logic** | `packages/shared/` | Agent, auth, config, sessions, MCP — runs server-side |

## What Needs to Be Built

A new **`apps/web/`** application — a standalone React+Vite web app that:
1. Connects to the headless server via WebSocket (like the CLI does, but with a GUI)
2. Reuses `@craft-agent/ui` components (like the viewer app does, but interactive)
3. Adds a chat input + session management UI (adapted from Electron renderer)

## Key Challenges and Solutions

| Challenge | Difficulty | Solution |
|-----------|-----------|----------|
| **Chat input & sending messages** | Medium | Build a WebSocket RPC client in the browser (the protocol is JSON-based, fully browser-compatible) |
| **MCP tool execution** | None | Already runs server-side — no browser changes needed |
| **File system access** | None | Sessions/configs stored server-side — web client just displays results |
| **OAuth flows** | Medium | Replace Electron deep links (`craftagents://`) with standard web OAuth redirects |
| **Credential storage** | None | Stays server-side with AES-256-GCM encryption |
| **Document processing (Python)** | None | Runs as server-side subprocesses — no browser impact |
| **Permission prompts** | Medium | The server already sends permission requests via RPC; web client needs UI to approve/deny |
| **Real-time streaming** | Low | WebSocket push events already stream agent responses to clients |

## Architecture

```
┌─────────────────────┐         WebSocket (ws/wss)         ┌──────────────────────┐
│   Web App (Browser)  │ ◄──────────────────────────────► │  Headless Server     │
│                      │                                    │  (packages/server/)  │
│  - React + Vite      │   Handshake + Auth                │                      │
│  - @craft-agent/ui   │   RPC requests/responses          │  - Agent execution   │
│  - WS RPC client     │   Push events (streaming)         │  - MCP connections   │
│  - Chat input        │                                    │  - Tool execution    │
│  - Session list      │                                    │  - Credential store  │
│  - Permission UI     │                                    │  - Session storage   │
└─────────────────────┘                                    └──────────────────────┘
```

## Implementation Phases

### Phase 1 — Minimal Interactive Web Client (~2-3 days)
- Create `apps/web/` with Vite + React + TailwindCSS
- Build a browser-side WebSocket RPC client (adapt `apps/cli/` transport code)
- Reuse `SessionViewer` from `@craft-agent/ui` for message display
- Add chat input component (adapt from Electron renderer)
- Connect to headless server with token auth

### Phase 2 — Full Feature Parity (~1-2 weeks)
- Session management (create, list, switch, delete)
- Permission approval UI (for tool use confirmations)
- Workspace switching
- Source/MCP connection management UI
- Settings/preferences panel
- OAuth flows via web redirects

### Phase 3 — Production Deployment (~1 week)
- Docker Compose setup (server + web app behind nginx/Caddy)
- TLS configuration for secure WebSocket (wss://)
- Multi-user support and auth
- Rate limiting and security hardening
- Monitoring and logging

## Key Files to Reference

- **Server entry**: `packages/server/src/index.ts`
- **Server bootstrap**: `packages/server-core/src/bootstrap/`
- **RPC handlers**: `packages/server-core/src/handlers/rpc/`
- **WebSocket transport**: `packages/server-core/src/transport/server.ts`
- **RPC protocol**: `packages/shared/src/protocol/`
- **Viewer app** (reference): `apps/viewer/src/App.tsx`
- **Electron renderer** (adapt from): `apps/electron/src/renderer/`
- **UI components**: `packages/ui/src/`

## Summary

Building a web version is **very feasible** because:
- The server already runs headless with WebSocket RPC + token auth
- The UI is already React-based with reusable components
- A working web viewer app already exists as proof of concept
- The only significant new code is a browser-side RPC client and chat input UI
- No core architecture changes are needed — just a new thin client app
