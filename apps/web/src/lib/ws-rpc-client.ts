/**
 * Browser WebSocket RPC client for Craft Agent server.
 *
 * Adapted from apps/cli/src/client.ts for browser-native WebSocket API.
 * Includes the wire codec inline (no server-core dependency in browser).
 */

// ---------------------------------------------------------------------------
// Protocol constants (from packages/shared/src/protocol/types.ts)
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = '1.0'

interface MessageEnvelope {
  id: string
  type: 'handshake' | 'handshake_ack' | 'request' | 'response' | 'event' | 'error'
  channel?: string
  args?: unknown[]
  result?: unknown
  error?: { code: string; message: string; data?: unknown }
  protocolVersion?: string
  workspaceId?: string
  token?: string
  clientId?: string
  serverId?: string
  clientCapabilities?: string[]
  registeredChannels?: string[]
}

// ---------------------------------------------------------------------------
// Wire codec (from packages/server-core/src/transport/codec.ts)
// ---------------------------------------------------------------------------

const WIRE_TYPE_KEY = '__craftRpcType'
const WIRE_BASE64_KEY = 'base64'
const UINT8_WIRE_TYPE = 'u8'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function decodeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWireValue)
  if (isRecord(value)) {
    if (value[WIRE_TYPE_KEY] === UINT8_WIRE_TYPE && typeof value[WIRE_BASE64_KEY] === 'string') {
      const binary = atob(value[WIRE_BASE64_KEY])
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    }
    const decoded: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) decoded[key] = decodeWireValue(val)
    return decoded
  }
  return value
}

function encodeWireValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < value.length; i += chunkSize) {
      binary += String.fromCharCode(...value.subarray(i, i + chunkSize))
    }
    return { [WIRE_TYPE_KEY]: UINT8_WIRE_TYPE, [WIRE_BASE64_KEY]: btoa(binary) }
  }
  if (Array.isArray(value)) return value.map(encodeWireValue)
  if (isRecord(value)) {
    const encoded: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) encoded[key] = encodeWireValue(val)
    return encoded
  }
  return value
}

function serialize(envelope: MessageEnvelope): string {
  return JSON.stringify(encodeWireValue(envelope))
}

function deserialize(raw: string): MessageEnvelope {
  return decodeWireValue(JSON.parse(raw)) as MessageEnvelope
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface WebRpcClientOptions {
  token?: string
  workspaceId?: string
  requestTimeout?: number
  connectTimeout?: number
  /** Auto-reconnect on disconnect. Default: true */
  autoReconnect?: boolean
  /** Max reconnect attempts. Default: 10 */
  maxReconnectAttempts?: number
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

type EventCallback = (...args: unknown[]) => void

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WebRpcClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<string, Set<EventCallback>>()
  private stateListeners = new Set<(state: ConnectionState) => void>()
  private _clientId: string | null = null
  private _state: ConnectionState = 'disconnected'
  private _destroyed = false
  private _registeredChannels: string[] = []
  private reconnectAttempts = 0

  private readonly url: string
  private readonly token: string | undefined
  private readonly workspaceId: string | undefined
  private readonly requestTimeout: number
  private readonly connectTimeout: number
  private readonly autoReconnect: boolean
  private readonly maxReconnectAttempts: number

  constructor(url: string, opts?: WebRpcClientOptions) {
    this.url = url
    this.token = opts?.token
    this.workspaceId = opts?.workspaceId
    this.requestTimeout = opts?.requestTimeout ?? 30_000
    this.connectTimeout = opts?.connectTimeout ?? 10_000
    this.autoReconnect = opts?.autoReconnect ?? true
    this.maxReconnectAttempts = opts?.maxReconnectAttempts ?? 10
  }

  get state(): ConnectionState { return this._state }
  get clientId(): string | null { return this._clientId }
  get isConnected(): boolean { return this._state === 'connected' }
  get registeredChannels(): string[] { return this._registeredChannels }

  /** Subscribe to connection state changes. Returns unsubscribe function. */
  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(callback)
    return () => this.stateListeners.delete(callback)
  }

  private setState(state: ConnectionState) {
    this._state = state
    for (const cb of this.stateListeners) {
      try { cb(state) } catch { /* ignore */ }
    }
  }

  /** Connect to the server and complete the handshake. Returns the assigned clientId. */
  async connect(): Promise<string> {
    if (this._destroyed) throw new Error('Client destroyed')
    this.setState('connecting')

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Connection timeout (${this.connectTimeout}ms)`))
        this.ws?.close()
      }, this.connectTimeout)

      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        const handshake: MessageEnvelope = {
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          workspaceId: this.workspaceId,
          token: this.token,
        }
        this.ws!.send(serialize(handshake))
      }

      this.ws.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data)
        let envelope: MessageEnvelope
        try { envelope = deserialize(raw) } catch { return }

        if (envelope.type === 'handshake_ack') {
          clearTimeout(timer)
          this._clientId = envelope.clientId ?? null
          this._registeredChannels = envelope.registeredChannels ?? []
          this.reconnectAttempts = 0
          this.setState('connected')
          // Switch to normal message handler
          this.ws!.onmessage = (e) => {
            this.onMessage(typeof e.data === 'string' ? e.data : String(e.data))
          }
          resolve(this._clientId!)
        } else if (envelope.type === 'error') {
          clearTimeout(timer)
          const err = new Error(envelope.error?.message ?? 'Connection rejected')
          ;(err as any).code = envelope.error?.code
          this.setState('disconnected')
          reject(err)
        }
      }

      this.ws.onerror = () => {
        if (this._state !== 'connected') {
          clearTimeout(timer)
          this.setState('disconnected')
          reject(new Error('WebSocket connection error'))
        }
      }

      this.ws.onclose = () => {
        const wasConnected = this._state === 'connected'
        this.setState('disconnected')
        if (!wasConnected) {
          clearTimeout(timer)
          reject(new Error('WebSocket closed before handshake'))
        }
        // Reject all pending requests
        for (const [, req] of this.pending) {
          clearTimeout(req.timeout)
          req.reject(new Error('Disconnected'))
        }
        this.pending.clear()
        // Auto-reconnect
        if (wasConnected && this.autoReconnect && !this._destroyed) {
          this.scheduleReconnect()
        }
      }
    })
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return
    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30_000)
    this.setState('reconnecting')
    setTimeout(() => {
      if (this._destroyed) return
      this.connect().catch(() => {
        // connect() rejection is expected during reconnect - scheduleReconnect will be called by onclose
      })
    }, delay)
  }

  /** Send an RPC request and await the response. */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (this._state !== 'connected' || !this.ws) {
      throw new Error(`Not connected (channel: ${channel})`)
    }

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${channel} (${this.requestTimeout}ms)`))
      }, this.requestTimeout)

      this.pending.set(id, { resolve, reject, timeout })

      const envelope: MessageEnvelope = {
        id,
        type: 'request',
        channel,
        args,
      }
      this.ws!.send(serialize(envelope))
    })
  }

  /** Subscribe to push events on a channel. Returns an unsubscribe function. */
  on(channel: string, callback: EventCallback): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(callback)
    return () => {
      set!.delete(callback)
      if (set!.size === 0) this.listeners.delete(channel)
    }
  }

  /** Close the connection and reject all pending requests. */
  destroy(): void {
    this._destroyed = true
    for (const [, req] of this.pending) {
      clearTimeout(req.timeout)
      req.reject(new Error('Client destroyed'))
    }
    this.pending.clear()
    this.ws?.close()
    this.ws = null
    this.setState('disconnected')
  }

  // -------------------------------------------------------------------------
  // Internal message routing
  // -------------------------------------------------------------------------

  private onMessage(raw: string): void {
    let envelope: MessageEnvelope
    try { envelope = deserialize(raw) } catch { return }

    switch (envelope.type) {
      case 'response': {
        const req = this.pending.get(envelope.id)
        if (req) {
          this.pending.delete(envelope.id)
          clearTimeout(req.timeout)
          if (envelope.error) {
            const err = new Error(envelope.error.message)
            ;(err as any).code = envelope.error.code
            ;(err as any).data = envelope.error.data
            req.reject(err)
          } else {
            req.resolve(envelope.result)
          }
        }
        break
      }
      case 'event': {
        if (envelope.channel) {
          const set = this.listeners.get(envelope.channel)
          if (set) {
            for (const cb of set) {
              try { cb(...(envelope.args ?? [])) } catch { /* ignore */ }
            }
          }
        }
        break
      }
    }
  }
}
