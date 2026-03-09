/**
 * Session sidebar — lists sessions and allows creating new ones.
 */

interface SessionInfo {
  id: string
  name?: string
  lastMessageAt: number
  isProcessing: boolean
}

interface SessionSidebarProps {
  sessions: SessionInfo[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onNewSession: () => void
  onDeleteSession: (id: string) => void
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
}: SessionSidebarProps) {
  return (
    <div className="w-64 h-full flex flex-col border-r border-border bg-background">
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="text-sm font-semibold">Sessions</span>
        <button
          onClick={onNewSession}
          className="px-2 py-1 text-xs rounded-md bg-accent text-white hover:opacity-90 transition-opacity"
        >
          + New
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No sessions yet
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => onSelectSession(session.id)}
              className={`group flex items-center justify-between px-3 py-2 cursor-pointer border-b border-border/50 hover:bg-foreground/5 transition-colors ${
                session.id === activeSessionId ? 'bg-accent/10 border-l-2 border-l-accent' : ''
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">
                  {session.name || `Session ${session.id.slice(0, 8)}`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {session.isProcessing ? (
                    <span className="text-accent">Working...</span>
                  ) : (
                    new Date(session.lastMessageAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  )}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteSession(session.id)
                }}
                className="hidden group-hover:block text-xs text-muted-foreground hover:text-destructive px-1"
                title="Delete session"
              >
                x
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
