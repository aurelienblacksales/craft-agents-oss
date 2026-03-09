import { OAuthFlowStore } from '@craft-agent/shared/auth'
import { ensureConfigDir, loadStoredConfig, saveConfig, addWorkspace, addLlmConnection, getLlmConnections, getDefaultModelsForConnection, getDefaultModelForConnection } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { getDefaultWorkspacesDir } from '@craft-agent/shared/workspaces'
import { setBundledAssetsRoot } from '@craft-agent/shared/utils'
import { WsRpcServer, type WsRpcTlsOptions } from '../transport/server'
import type { EventSink, RpcServer } from '../transport/types'
import { createHeadlessPlatform } from '../runtime/platform-headless'
import type { PlatformServices } from '../runtime/platform'
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'

interface ModelRefreshServiceLike {
  startAll(): void
  stopAll?(): void
}

export interface HeadlessServerBootstrapOptions<TSessionManager, THandlerDeps> {
  serverToken?: string
  rpcHost?: string
  rpcPort?: number
  bundledAssetsRoot?: string
  platformFactory?: () => PlatformServices
  applyPlatformToSubsystems?: (platform: PlatformServices) => void
  createSessionManager: () => TSessionManager
  createHandlerDeps: (ctx: {
    sessionManager: TSessionManager
    platform: PlatformServices
    oauthFlowStore: OAuthFlowStore
  }) => THandlerDeps
  registerAllRpcHandlers: (server: RpcServer, deps: THandlerDeps) => void
  initializeSessionManager: (sessionManager: TSessionManager) => Promise<void>
  setSessionEventSink: (sessionManager: TSessionManager, sink: EventSink) => void
  initModelRefreshService: () => ModelRefreshServiceLike
  cleanupSessionManager?: (sessionManager: TSessionManager) => Promise<void> | void
  cleanupClientResources?: (clientId: string) => void
  serverId?: string
  /** TLS configuration. When provided, the server listens on wss:// instead of ws://. */
  tls?: WsRpcTlsOptions
}

export interface HeadlessServerInstance<TSessionManager> {
  platform: PlatformServices
  sessionManager: TSessionManager
  wsServer: WsRpcServer
  oauthFlowStore: OAuthFlowStore
  host: string
  port: number
  protocol: 'ws' | 'wss'
  token: string
  stop: () => Promise<void>
}

function bootstrapConfigArtifacts(platform: PlatformServices): void {
  ensureConfigDir()
  platform.logger.info('[headless] Config artifacts initialized')
}

function ensureGlobalConfigExists(platform: PlatformServices): void {
  const config = loadStoredConfig()
  if (config) {
    platform.logger.info('[headless] Global config found')
    return
  }

  saveConfig({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  })
  platform.logger.info('[headless] Initialized missing global config')
}

/**
 * Auto-create a default workspace and LLM connection on first boot.
 * Enables the web client to work immediately without manual onboarding.
 */
async function ensureHeadlessDefaults(platform: PlatformServices): Promise<void> {
  const config = loadStoredConfig()
  if (!config) return

  // 1. Create default workspace if none exist
  if (!config.workspaces || config.workspaces.length === 0) {
    const workspacePath = join(getDefaultWorkspacesDir(), 'default')
    const workspace = addWorkspace({ name: 'Default Workspace', rootPath: workspacePath })
    platform.logger.info(`[headless] Created default workspace: ${workspace.id}`)
  }

  // 2. Create Anthropic LLM connection from env var if no connections exist
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (apiKey && (!getLlmConnections() || getLlmConnections().length === 0)) {
    const added = addLlmConnection({
      slug: 'anthropic-api',
      name: 'Anthropic (API Key)',
      providerType: 'anthropic',
      authType: 'api_key',
      models: getDefaultModelsForConnection('anthropic'),
      defaultModel: getDefaultModelForConnection('anthropic'),
      createdAt: Date.now(),
    })

    if (added) {
      const manager = getCredentialManager()
      await manager.setLlmApiKey('anthropic-api', apiKey)
      platform.logger.info('[headless] Created default Anthropic LLM connection from ANTHROPIC_API_KEY')
    }
  }
}

/**
 * Start a bare HTTP health server immediately so PaaS healthchecks pass
 * while the full bootstrap runs. Returns the listening server.
 */
function startHealthServer(host: string, port: number): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const handler = (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"status":"ok"}')
    }
    const server = createHttpServer(handler)
    server.on('error', reject)
    server.listen(port, host, () => {
      console.log(`[craft-server] Health endpoint listening on ${host}:${port}`)
      resolve(server)
    })
  })
}

export async function startHeadlessServer<TSessionManager, THandlerDeps>(
  options: HeadlessServerBootstrapOptions<TSessionManager, THandlerDeps>,
): Promise<HeadlessServerInstance<TSessionManager>> {
  const serverToken = options.serverToken ?? process.env.CRAFT_SERVER_TOKEN
  if (!serverToken) {
    throw new Error('Server token is required. Pass options.serverToken or set CRAFT_SERVER_TOKEN.')
  }

  // Resolve host/port early so we can start the health server ASAP
  const rpcHost = options.rpcHost ?? process.env.CRAFT_RPC_HOST ?? '127.0.0.1'
  const rpcPortRaw = options.rpcPort ?? parseInt(process.env.CRAFT_RPC_PORT ?? process.env.PORT ?? '9100', 10)
  if (!Number.isFinite(rpcPortRaw) || rpcPortRaw < 0 || rpcPortRaw > 65535) {
    throw new Error(`Invalid RPC port: ${rpcPortRaw}`)
  }
  const rpcPort = Math.trunc(rpcPortRaw)

  // Start HTTP health server immediately — PaaS healthchecks pass while we bootstrap
  const healthServer = options.tls ? null : await startHealthServer(rpcHost, rpcPort)

  const platform = options.platformFactory?.() ?? createHeadlessPlatform()

  const bundledAssetsRoot = options.bundledAssetsRoot
    ?? process.env.CRAFT_BUNDLED_ASSETS_ROOT
    ?? process.cwd()
  setBundledAssetsRoot(bundledAssetsRoot)

  options.applyPlatformToSubsystems?.(platform)

  platform.logger.info('[headless] Bootstrapping config artifacts...')
  bootstrapConfigArtifacts(platform)

  platform.logger.info('[headless] Ensuring global config...')
  ensureGlobalConfigExists(platform)

  platform.logger.info('[headless] Setting up headless defaults...')
  await ensureHeadlessDefaults(platform)

  platform.logger.info('[headless] Initializing model refresh service...')
  const modelRefreshService = options.initModelRefreshService()
  const sessionManager = options.createSessionManager()

  // Attach WebSocket handling to the already-listening HTTP server
  const wsServer = new WsRpcServer({
    host: rpcHost,
    port: rpcPort,
    requireAuth: true,
    validateToken: async (t) => t === serverToken,
    serverId: options.serverId ?? 'headless',
    tls: options.tls,
    onClientDisconnected: (clientId) => {
      options.cleanupClientResources?.(clientId)
    },
    ...(healthServer ? { existingHttpServer: healthServer } : {}),
  })

  platform.logger.info('[headless] Attaching WebSocket server...')
  await wsServer.listen()

  const oauthFlowStore = new OAuthFlowStore()

  const deps = options.createHandlerDeps({
    sessionManager,
    platform,
    oauthFlowStore,
  })

  options.registerAllRpcHandlers(wsServer, deps)

  options.setSessionEventSink(sessionManager, wsServer.push.bind(wsServer))

  platform.logger.info('[headless] Initializing session manager...')
  await options.initializeSessionManager(sessionManager)

  modelRefreshService.startAll()

  platform.logger.info(`Craft Agent headless server ready on ${wsServer.protocol}://${rpcHost}:${wsServer.port}`)

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true

    platform.logger.info('Shutting down...')

    try {
      modelRefreshService.stopAll?.()
    } catch (error) {
      platform.logger.error('[headless] Failed to stop model refresh service:', error)
    }

    try {
      await options.cleanupSessionManager?.(sessionManager)
    } catch (error) {
      platform.logger.error('[headless] Failed to clean up session manager:', error)
    }

    try {
      wsServer.close()
    } catch (error) {
      platform.logger.error('[headless] Failed to close WS server:', error)
    }

    try {
      oauthFlowStore.dispose()
    } catch (error) {
      platform.logger.error('[headless] Failed to dispose OAuth flow store:', error)
    }
  }

  return {
    platform,
    sessionManager,
    wsServer,
    oauthFlowStore,
    host: rpcHost,
    port: wsServer.port,
    protocol: wsServer.protocol,
    token: serverToken,
    stop,
  }
}
