/**
 * Connection screen — shown when the client is not connected to a server.
 * Lets the user enter the server URL and token.
 */

import { useState } from 'react'
import type { ConnectionState } from '@/lib/ws-rpc-client'

interface ConnectScreenProps {
  state: ConnectionState
  error: string | null
  onConnect: (url: string, token: string) => void
}

export function ConnectScreen({ state, error, onConnect }: ConnectScreenProps) {
  const [url, setUrl] = useState(() => {
    // In dev, default to the Vite proxy path
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
      return `ws://${window.location.host}/ws`
    }
    return localStorage.getItem('craft-server-url') || ''
  })
  const [token, setToken] = useState(() => localStorage.getItem('craft-server-token') || '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    localStorage.setItem('craft-server-url', url)
    localStorage.setItem('craft-server-token', token)
    onConnect(url, token)
  }

  const isConnecting = state === 'connecting' || state === 'reconnecting'

  return (
    <div className="h-full flex items-center justify-center bg-foreground-2 text-foreground">
      <div className="w-full max-w-md p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold mb-2">Craft Agents</h1>
          <p className="text-muted-foreground text-sm">
            Connect to your Craft Agent server
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="server-url" className="block text-sm font-medium mb-1">
              Server URL
            </label>
            <input
              id="server-url"
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://127.0.0.1:9100 or wss://your-server.up.railway.app"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              disabled={isConnecting}
              required
            />
          </div>

          <div>
            <label htmlFor="server-token" className="block text-sm font-medium mb-1">
              Server Token
            </label>
            <input
              id="server-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="CRAFT_SERVER_TOKEN value"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-accent"
              disabled={isConnecting}
              required
            />
          </div>

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isConnecting}
            className="w-full py-2 px-4 rounded-md bg-accent text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isConnecting ? 'Connecting...' : 'Connect'}
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-muted-foreground">
          <p>Start the server with:</p>
          <code className="block mt-1 px-2 py-1 rounded bg-foreground/5 font-mono text-xs">
            CRAFT_SERVER_TOKEN=secret bun run packages/server/src/index.ts
          </code>
        </div>
      </div>
    </div>
  )
}
