/**
 * Permission dialog — shown when the agent requests tool use permission.
 */

interface PermissionDialogProps {
  sessionId: string
  request: {
    id: string
    toolName: string
    toolInput: Record<string, unknown>
    description?: string
  }
  onRespond: (sessionId: string, requestId: string, allowed: boolean) => void
}

export function PermissionDialog({ sessionId, request, onRespond }: PermissionDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background border border-border rounded-lg shadow-lg max-w-lg w-full mx-4 p-6">
        <h3 className="text-sm font-semibold mb-2">Permission Request</h3>
        <p className="text-sm text-muted-foreground mb-4">
          The agent wants to use <strong>{request.toolName}</strong>
        </p>

        {request.description && (
          <p className="text-sm text-muted-foreground mb-4 italic">{request.description}</p>
        )}

        <div className="bg-foreground-2 rounded-md p-3 mb-4 max-h-48 overflow-y-auto">
          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
            {JSON.stringify(request.toolInput, null, 2)}
          </pre>
        </div>

        <div className="flex gap-2 justify-end">
          <button
            onClick={() => onRespond(sessionId, request.id, false)}
            className="px-4 py-2 rounded-md border border-border text-sm hover:bg-foreground/5 transition-colors"
          >
            Deny
          </button>
          <button
            onClick={() => onRespond(sessionId, request.id, true)}
            className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
