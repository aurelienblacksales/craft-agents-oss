/**
 * Web API adapter — creates the ElectronAPI-compatible interface for the web client.
 *
 * Connects to the server via WebSocket, builds the API proxy from the channel map,
 * and registers web-specific capability handlers (replacing Electron's preload).
 */

import { WsRpcClient } from './client'
import type { WsRpcClientOptions } from './client'
import { buildClientApi } from './build-api'
import { CHANNEL_MAP } from './channel-map'
import type { ElectronAPI, TransportConnectionState } from '../shared/types'

// ---------------------------------------------------------------------------
// Config — read from env or URL params
// ---------------------------------------------------------------------------

function getServerUrl(): string {
  // In production, WebSocket connects through the same origin
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'

  // Dev mode: proxy through Vite (/ws → localhost:9100)
  if (import.meta.env.DEV) {
    return `${proto}//${location.host}/ws`
  }

  // Production: connect to same host on /ws path (nginx proxies to server)
  return `${proto}//${location.host}/ws`
}

function getToken(): string {
  // Check URL params first (for direct links)
  const params = new URLSearchParams(location.search)
  const urlToken = params.get('token')
  if (urlToken) {
    // Store it and clean URL
    sessionStorage.setItem('craft-token', urlToken)
    history.replaceState(null, '', location.pathname)
    return urlToken
  }

  // Check sessionStorage
  const stored = sessionStorage.getItem('craft-token')
  if (stored) return stored

  // Check localStorage (persisted across sessions)
  const persisted = localStorage.getItem('craft-token')
  if (persisted) return persisted

  return ''
}

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let client: WsRpcClient | null = null
let webApi: ElectronAPI | null = null

export function getClient(): WsRpcClient {
  if (!client) {
    throw new Error('WebSocket client not initialized. Call initWebApi() first.')
  }
  return client
}

export function getWebApi(): ElectronAPI {
  if (!webApi) {
    throw new Error('Web API not initialized. Call initWebApi() first.')
  }
  return webApi
}

/**
 * Initialize the WebSocket client and build the API proxy.
 * Should be called once at app startup.
 */
export function initWebApi(workspaceId?: string): ElectronAPI {
  if (webApi) return webApi

  const url = getServerUrl()
  const token = getToken()

  const opts: WsRpcClientOptions = {
    workspaceId,
    token: token || undefined,
    mode: 'remote',
    clientCapabilities: [
      'openExternal',
      'confirmDialog',
    ],
  }

  client = new WsRpcClient(url, opts)

  // Register web-specific capability handlers
  // These replace the Electron preload capability handlers

  // openExternal: open URL in new tab (replaces shell.openExternal)
  client.handleCapability('openExternal', (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    return { success: true }
  })

  // confirmDialog: show browser confirm dialog (replaces Electron dialog.showMessageBox)
  client.handleCapability('confirmDialog', (message: string, title?: string) => {
    const result = window.confirm(title ? `${title}\n\n${message}` : message)
    return { confirmed: result }
  })

  // Build the API proxy from channel map
  const api = buildClientApi(
    client,
    CHANNEL_MAP,
    (channel: string) => client!.isChannelAvailable(channel),
  )

  // Add web-specific methods that don't go through RPC

  // Transport connection state (direct from client, not RPC)
  ;(api as any).getTransportConnectionState = async (): Promise<TransportConnectionState> => {
    return client!.getConnectionState()
  }
  ;(api as any).onTransportConnectionStateChanged = (
    callback: (state: TransportConnectionState) => void,
  ): (() => void) => {
    return client!.onConnectionStateChanged(callback)
  }
  ;(api as any).reconnectTransport = async (): Promise<void> => {
    client!.reconnectNow()
  }

  // performOAuth: web-based OAuth flow (popup window + server-side callback)
  ;(api as any).performOAuth = async (args: {
    sourceSlug: string
    sessionId?: string
    authRequestId?: string
  }): Promise<{ success: boolean; error?: string; email?: string }> => {
    try {
      // Build the redirect URI pointing to our server's OAuth callback endpoint
      const redirectUri = `${window.location.origin}/oauth/callback`

      // Start OAuth via RPC — server returns the auth URL, state, flowId
      const startResult = await client!.invoke('oauth:start', {
        sourceSlug: args.sourceSlug,
        callbackPort: 0, // Not used when redirectUri is provided
        sessionId: args.sessionId,
        authRequestId: args.authRequestId,
        redirectUri,
      })
      if (!startResult?.authUrl) {
        return { success: false, error: 'No auth URL returned from server' }
      }

      // Open popup window for OAuth consent
      const popup = window.open(
        startResult.authUrl,
        'oauth-popup',
        'width=600,height=700,scrollbars=yes',
      )

      if (!popup) {
        return { success: false, error: 'Popup blocked. Please allow popups for this site.' }
      }

      // Wait for OAuth callback via postMessage from the /oauth/callback HTML page
      const callbackResult = await new Promise<{ code?: string; state?: string; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          window.removeEventListener('message', handler)
          resolve({ error: 'OAuth timeout — window was closed or no response' })
        }, 300_000) // 5 minute timeout

        function handler(event: MessageEvent) {
          if (event.data?.type === 'oauth-callback') {
            clearTimeout(timeout)
            window.removeEventListener('message', handler)
            resolve(event.data.result || {})
          }
        }

        window.addEventListener('message', handler)

        const pollTimer = setInterval(() => {
          if (popup.closed) {
            clearInterval(pollTimer)
            clearTimeout(timeout)
            window.removeEventListener('message', handler)
            resolve({ error: 'OAuth window was closed' })
          }
        }, 500)
      })

      if (callbackResult.error) {
        // Cancel the flow on the server
        await client!.invoke('oauth:cancel', {
          flowId: startResult.flowId,
          state: startResult.state,
        }).catch(() => {})
        return { success: false, error: callbackResult.error }
      }

      if (!callbackResult.code) {
        return { success: false, error: 'No authorization code received' }
      }

      // Complete the OAuth flow — exchange code for tokens on the server
      const completeResult = await client!.invoke('oauth:complete', {
        flowId: startResult.flowId,
        code: callbackResult.code,
        state: callbackResult.state || startResult.state,
      })

      return completeResult
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // Stubs for desktop-only features

  // Shell operations — web replacements
  const originalOpenUrl = api.openUrl
  ;(api as any).openUrl = async (url: string): Promise<void> => {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  ;(api as any).openFile = async (path: string): Promise<void> => {
    // No-op in web — can't open local files
    console.warn('[web] openFile is not supported:', path)
  }
  ;(api as any).showInFolder = async (path: string): Promise<void> => {
    // No-op in web — can't show in file manager
    console.warn('[web] showInFolder is not supported:', path)
  }

  // System info stubs
  ;(api as any).getVersions = () => ({
    node: 'web',
    chrome: navigator.userAgent,
    electron: 'web',
  })

  // Window management stubs
  ;(api as any).closeWindow = async () => { window.close() }
  ;(api as any).confirmCloseWindow = async () => {}
  ;(api as any).cancelCloseWindow = async () => {}
  ;(api as any).onCloseRequested = () => () => {}
  ;(api as any).setTrafficLightsVisible = async () => {}
  ;(api as any).openSessionInNewWindow = async () => {}

  // Update stubs (no auto-update in web)
  ;(api as any).checkForUpdates = async () => ({ available: false })
  ;(api as any).getUpdateInfo = async () => ({ available: false })
  ;(api as any).installUpdate = async () => {}
  ;(api as any).dismissUpdate = async () => {}
  ;(api as any).getDismissedUpdateVersion = async () => null
  ;(api as any).onUpdateAvailable = () => () => {}
  ;(api as any).onUpdateDownloadProgress = () => () => {}

  // Release notes stubs
  ;(api as any).getReleaseNotes = async () => ''
  ;(api as any).getLatestReleaseVersion = async () => undefined

  // Menu stubs (handled by browser chrome)
  ;(api as any).onMenuNewChat = () => () => {}
  ;(api as any).onMenuOpenSettings = () => () => {}
  ;(api as any).onMenuKeyboardShortcuts = () => () => {}
  ;(api as any).onMenuToggleFocusMode = () => () => {}
  ;(api as any).onMenuToggleSidebar = () => () => {}
  ;(api as any).menuQuit = async () => {}
  ;(api as any).menuNewWindow = async () => { window.open(location.href) }
  ;(api as any).menuMinimize = async () => {}
  ;(api as any).menuMaximize = async () => {}
  ;(api as any).menuZoomIn = async () => {}
  ;(api as any).menuZoomOut = async () => {}
  ;(api as any).menuZoomReset = async () => {}
  ;(api as any).menuToggleDevTools = async () => {}
  ;(api as any).menuUndo = async () => { document.execCommand('undo') }
  ;(api as any).menuRedo = async () => { document.execCommand('redo') }
  ;(api as any).menuCut = async () => { document.execCommand('cut') }
  ;(api as any).menuCopy = async () => { document.execCommand('copy') }
  ;(api as any).menuPaste = async () => { document.execCommand('paste') }
  ;(api as any).menuSelectAll = async () => { document.execCommand('selectAll') }

  // Deep link stub
  ;(api as any).onDeepLinkNavigate = () => () => {}

  // Badge stubs (no dock icon in web)
  ;(api as any).refreshBadge = async () => {}
  ;(api as any).setDockIconWithBadge = async () => {}
  ;(api as any).onBadgeDraw = () => () => {}
  ;(api as any).onBadgeDrawWindows = () => () => {}

  // Window focus (always focused in web context)
  ;(api as any).getWindowFocusState = async () => document.hasFocus()
  ;(api as any).onWindowFocusChange = (cb: (focused: boolean) => void) => {
    const onFocus = () => cb(true)
    const onBlur = () => cb(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }
  ;(api as any).onNotificationNavigate = () => () => {}

  // Notification stubs
  ;(api as any).showNotification = async (title: string, body: string) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body })
    }
  }

  // File dialog — use browser file input
  ;(api as any).openFileDialog = async (): Promise<string[]> => {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.onchange = () => {
        const files = Array.from(input.files ?? [])
        resolve(files.map(f => f.name))
      }
      input.click()
    })
  }

  // Folder dialog stub
  ;(api as any).openFolderDialog = async (): Promise<string | null> => null

  // Power settings stubs
  ;(api as any).getKeepAwakeWhileRunning = async () => false
  ;(api as any).setKeepAwakeWhileRunning = async () => {}

  // Git bash stubs (Windows only)
  ;(api as any).checkGitBash = async () => ({ available: false })
  ;(api as any).browseForGitBash = async () => null
  ;(api as any).setGitBashPath = async () => ({ success: false })

  // Skills: stub desktop-only operations
  ;(api as any).openSkillInEditor = async () => {}
  ;(api as any).openSkillInFinder = async () => {}

  // Debug log — send to console
  ;(api as any).debugLog = (...args: unknown[]) => {
    console.debug('[craft]', ...args)
  }

  // Browser pane stubs (Electron BrowserView)
  ;(api as any).browserPane = {
    create: async () => '',
    destroy: async () => {},
    list: async () => [],
    navigate: async () => ({ url: '', title: '' }),
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    stop: async () => {},
    focus: async () => {},
    emptyStateLaunch: async () => ({ ok: false, handled: false }),
    onStateChanged: () => () => {},
    onRemoved: () => () => {},
    onInteracted: () => () => {},
  }

  // Expose globally for compatibility with existing renderer code
  ;(window as any).electronAPI = api

  webApi = api

  // Connect
  client.connect()

  return api
}
