/**
 * Craft Agent Web Client — Main Application
 *
 * Connects to the headless server via WebSocket RPC, manages sessions,
 * and renders the chat UI using @craft-agent/ui components.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import type { StoredSession } from '@craft-agent/core'
import type { Message } from '@craft-agent/core/types'
import {
  SessionViewer,
  GenericOverlay,
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  JSONPreviewOverlay,
  DocumentFormattedMarkdownOverlay,
  TooltipProvider,
  extractOverlayData,
  detectLanguage,
  type PlatformActions,
  type ActivityItem,
  type OverlayData,
  type FileChange,
} from '@craft-agent/ui'
import { WebRpcClient, type ConnectionState } from '@/lib/ws-rpc-client'
import { ConnectScreen } from '@/components/ConnectScreen'
import { ChatInput } from '@/components/ChatInput'
import { SessionSidebar } from '@/components/SessionSidebar'
import { PermissionDialog } from '@/components/PermissionDialog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionInfo {
  id: string
  name?: string
  lastMessageAt: number
  isProcessing: boolean
}

interface PendingPermission {
  sessionId: string
  request: {
    id: string
    toolName: string
    toolInput: Record<string, unknown>
    description?: string
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  // Connection state
  const clientRef = useRef<WebRpcClient | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [connectionError, setConnectionError] = useState<string | null>(null)

  // Session state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)

  // Permission state
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)

  // Theme
  const [isDark, setIsDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => setIsDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Overlay state (copied from viewer)
  const [overlayActivity, setOverlayActivity] = useState<ActivityItem | null>(null)
  const [multiDiffState, setMultiDiffState] = useState<{ changes: FileChange[] } | null>(null)

  const handleActivityClick = useCallback((activity: ActivityItem) => {
    if (activity.toolName === 'Edit' || activity.toolName === 'Write') {
      const input = activity.toolInput as Record<string, unknown> | undefined
      const filePath = (input?.file_path as string) || (input?.path as string) || 'unknown'
      const change: FileChange = {
        id: activity.id,
        filePath,
        toolType: activity.toolName,
        original: activity.toolName === 'Edit'
          ? ((input?.old_string as string) || (input?.oldText as string) || '')
          : '',
        modified: activity.toolName === 'Edit'
          ? ((input?.new_string as string) || (input?.newText as string) || '')
          : ((input?.content as string) || ''),
        error: activity.error || undefined,
      }
      setMultiDiffState({ changes: [change] })
    } else {
      setOverlayActivity(activity)
    }
  }, [])

  const handleCloseOverlay = useCallback(() => {
    setOverlayActivity(null)
    setMultiDiffState(null)
  }, [])

  const overlayData: OverlayData | null = useMemo(() => {
    if (!overlayActivity) return null
    return extractOverlayData(overlayActivity)
  }, [overlayActivity])

  const platformActions: PlatformActions = {
    onOpenUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    onCopyToClipboard: async (text) => navigator.clipboard.writeText(text),
  }

  const theme = isDark ? 'dark' : 'light'

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  const handleConnect = useCallback(async (url: string, token: string) => {
    // Cleanup previous client
    if (clientRef.current) {
      clientRef.current.destroy()
    }

    const client = new WebRpcClient(url, { token })
    clientRef.current = client
    setConnectionError(null)

    // Track state changes
    client.onStateChange(setConnectionState)

    // Subscribe to session events
    client.on('session:event', (event: any) => {
      if (!event || typeof event !== 'object') return
      const sessionId = event.sessionId

      switch (event.type) {
        case 'text_delta':
          setMessages(prev => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant') {
              return [
                ...prev.slice(0, -1),
                { ...last, content: (typeof last.content === 'string' ? last.content : '') + event.delta },
              ]
            }
            return [...prev, { role: 'assistant', content: event.delta } as Message]
          })
          break

        case 'text_complete':
          setMessages(prev => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: event.text } as Message]
            }
            return [...prev, { role: 'assistant', content: event.text } as Message]
          })
          break

        case 'tool_start':
          setMessages(prev => [
            ...prev,
            {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: event.toolUseId, name: event.toolName, input: event.toolInput },
              ],
            } as Message,
          ])
          break

        case 'tool_result':
          setMessages(prev => [
            ...prev,
            {
              role: 'tool',
              content: event.result,
              tool_use_id: event.toolUseId,
            } as unknown as Message,
          ])
          break

        case 'complete':
          setIsProcessing(false)
          // Refresh session list
          loadSessions(client)
          break

        case 'error':
        case 'typed_error':
          setIsProcessing(false)
          break

        case 'interrupted':
          setIsProcessing(false)
          break

        case 'title_generated':
          setSessions(prev =>
            prev.map(s => s.id === sessionId ? { ...s, name: event.title } : s)
          )
          break

        case 'permission_request':
          setPendingPermission({
            sessionId,
            request: {
              id: event.request.id,
              toolName: event.request.toolName,
              toolInput: event.request.toolInput || {},
              description: event.request.description,
            },
          })
          break

        case 'session_created':
          loadSessions(client)
          break

        case 'session_deleted':
          setSessions(prev => prev.filter(s => s.id !== sessionId))
          break

        case 'user_message':
          // User message accepted/queued — no-op, we already show it optimistically
          break
      }
    })

    try {
      await client.connect()

      // Load workspaces
      const workspaces = await client.invoke('workspaces:get') as any[]
      if (workspaces.length > 0) {
        setWorkspaceId(workspaces[0].id)
        await loadSessions(client, workspaces[0].id)
      }
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const loadSessions = async (client?: WebRpcClient, wsId?: string) => {
    const c = client || clientRef.current
    if (!c?.isConnected) return
    const wId = wsId || workspaceId
    if (!wId) return

    try {
      const result = await c.invoke('sessions:get', wId) as any[]
      setSessions(
        result.map((s: any) => ({
          id: s.id,
          name: s.name,
          lastMessageAt: s.lastMessageAt || Date.now(),
          isProcessing: s.isProcessing || false,
        })).sort((a: SessionInfo, b: SessionInfo) => b.lastMessageAt - a.lastMessageAt)
      )
    } catch {
      // Session list may not be available yet
    }
  }

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  const handleSelectSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (!client?.isConnected) return

    setActiveSessionId(sessionId)
    setMessages([])

    try {
      const msgs = await client.invoke('sessions:getMessages', sessionId) as Message[]
      setMessages(msgs || [])
      // Check if processing
      const session = sessions.find(s => s.id === sessionId)
      setIsProcessing(session?.isProcessing || false)
    } catch {
      // Session may have been deleted
    }
  }, [sessions])

  const handleNewSession = useCallback(async () => {
    const client = clientRef.current
    if (!client?.isConnected || !workspaceId) return

    try {
      const session = await client.invoke('sessions:create', workspaceId, {}) as any
      setActiveSessionId(session.id)
      setMessages([])
      setIsProcessing(false)
      await loadSessions()
    } catch (err) {
      console.error('Failed to create session:', err)
    }
  }, [workspaceId])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const client = clientRef.current
    if (!client?.isConnected) return

    try {
      await client.invoke('sessions:delete', sessionId)
      if (activeSessionId === sessionId) {
        setActiveSessionId(null)
        setMessages([])
      }
      setSessions(prev => prev.filter(s => s.id !== sessionId))
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }, [activeSessionId])

  // -------------------------------------------------------------------------
  // Message sending
  // -------------------------------------------------------------------------

  const handleSendMessage = useCallback(async (text: string) => {
    const client = clientRef.current
    if (!client?.isConnected || !workspaceId) return

    let sessionId = activeSessionId

    // Create a session if none is active
    if (!sessionId) {
      try {
        const session = await client.invoke('sessions:create', workspaceId, {}) as any
        sessionId = session.id
        setActiveSessionId(sessionId)
        await loadSessions()
      } catch {
        return
      }
    }

    // Add user message optimistically
    setMessages(prev => [...prev, { role: 'user', content: text } as Message])
    setIsProcessing(true)

    try {
      await client.invoke('sessions:sendMessage', sessionId, text)
    } catch (err) {
      console.error('Failed to send message:', err)
      setIsProcessing(false)
    }
  }, [activeSessionId, workspaceId])

  const handleCancel = useCallback(async () => {
    const client = clientRef.current
    if (!client?.isConnected || !activeSessionId) return

    try {
      await client.invoke('sessions:cancel', activeSessionId)
    } catch {
      // May already be done
    }
    setIsProcessing(false)
  }, [activeSessionId])

  // -------------------------------------------------------------------------
  // Permission handling
  // -------------------------------------------------------------------------

  const handlePermissionRespond = useCallback(async (
    sessionId: string,
    requestId: string,
    allowed: boolean,
  ) => {
    const client = clientRef.current
    if (!client?.isConnected) return

    try {
      await client.invoke('sessions:respondToPermission', sessionId, requestId, allowed, {})
    } catch (err) {
      console.error('Failed to respond to permission:', err)
    }
    setPendingPermission(null)
  }, [])

  // -------------------------------------------------------------------------
  // Build a StoredSession for SessionViewer
  // -------------------------------------------------------------------------

  const viewerSession: StoredSession | null = useMemo(() => {
    if (!activeSessionId || messages.length === 0) return null
    return {
      id: activeSessionId,
      name: sessions.find(s => s.id === activeSessionId)?.name || 'Session',
      messages,
    } as StoredSession
  }, [activeSessionId, messages, sessions])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Not connected — show connection screen
  if (connectionState === 'disconnected' || connectionState === 'connecting') {
    return (
      <ConnectScreen
        state={connectionState}
        error={connectionError}
        onConnect={handleConnect}
      />
    )
  }

  return (
    <TooltipProvider>
      <div className="h-full flex bg-foreground-2 text-foreground">
        {/* Sidebar */}
        <SessionSidebar
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onDeleteSession={handleDeleteSession}
        />

        {/* Main content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="h-12 border-b border-border bg-background flex items-center px-4 justify-between">
            <div className="text-sm font-medium truncate">
              {activeSessionId
                ? sessions.find(s => s.id === activeSessionId)?.name || 'New Session'
                : 'Craft Agents'}
            </div>
            <div className="flex items-center gap-2">
              {connectionState === 'reconnecting' && (
                <span className="text-xs text-warning">Reconnecting...</span>
              )}
              <div
                className={`w-2 h-2 rounded-full ${
                  connectionState === 'connected' ? 'bg-green-500' : 'bg-yellow-500'
                }`}
                title={connectionState}
              />
            </div>
          </div>

          {/* Chat content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {viewerSession ? (
              <SessionViewer
                session={viewerSession}
                mode="readonly"
                platformActions={platformActions}
                defaultExpanded={false}
                className="flex-1 min-h-0"
                onActivityClick={handleActivityClick}
              />
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                {activeSessionId ? 'No messages yet' : 'Select or create a session to start'}
              </div>
            )}
          </div>

          {/* Input */}
          <ChatInput
            onSend={handleSendMessage}
            onCancel={handleCancel}
            isProcessing={isProcessing}
            disabled={connectionState !== 'connected'}
          />
        </div>

        {/* Permission dialog */}
        {pendingPermission && (
          <PermissionDialog
            sessionId={pendingPermission.sessionId}
            request={pendingPermission.request}
            onRespond={handlePermissionRespond}
          />
        )}

        {/* Overlays (from viewer) */}
        {overlayData?.type === 'code' && (
          <CodePreviewOverlay
            isOpen={!!overlayActivity}
            onClose={handleCloseOverlay}
            content={overlayData.content}
            filePath={overlayData.filePath}
            mode={overlayData.mode}
            startLine={overlayData.startLine}
            totalLines={overlayData.totalLines}
            numLines={overlayData.numLines}
            theme={theme}
            error={overlayData.error}
            command={overlayData.command}
          />
        )}

        {multiDiffState && (
          <MultiDiffPreviewOverlay
            isOpen={true}
            onClose={handleCloseOverlay}
            changes={multiDiffState.changes}
            consolidated={false}
            theme={theme}
          />
        )}

        {overlayData?.type === 'terminal' && (
          <TerminalPreviewOverlay
            isOpen={!!overlayActivity}
            onClose={handleCloseOverlay}
            command={overlayData.command}
            output={overlayData.output}
            exitCode={overlayData.exitCode}
            toolType={overlayData.toolType}
            description={overlayData.description}
            theme={theme}
          />
        )}

        {overlayData?.type === 'json' && (
          <JSONPreviewOverlay
            isOpen={!!overlayActivity}
            onClose={handleCloseOverlay}
            data={overlayData.data}
            title={overlayData.title}
            theme={theme}
            error={overlayData.error}
          />
        )}

        {overlayData?.type === 'document' && (
          <DocumentFormattedMarkdownOverlay
            isOpen={!!overlayActivity}
            onClose={handleCloseOverlay}
            content={overlayData.content}
            filePath={overlayData.filePath}
            typeBadge={{ label: overlayData.toolName, variant: 'default' }}
            onOpenUrl={platformActions.onOpenUrl}
            error={overlayData.error}
          />
        )}

        {overlayData?.type === 'generic' && (
          detectLanguage(overlayData.content) === 'markdown' ? (
            <DocumentFormattedMarkdownOverlay
              isOpen={!!overlayActivity}
              onClose={handleCloseOverlay}
              content={overlayData.content}
              onOpenUrl={platformActions.onOpenUrl}
              error={overlayData.error}
            />
          ) : (
            <GenericOverlay
              isOpen={!!overlayActivity}
              onClose={handleCloseOverlay}
              content={overlayData.content}
              title={overlayData.title}
              theme={theme}
            />
          )
        )}
      </div>
    </TooltipProvider>
  )
}
