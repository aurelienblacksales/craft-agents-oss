/**
 * Lightweight HTTP server for web deployment endpoints.
 *
 * Creates an http.Server that handles:
 * - GET  /health          — health check (Railway, Docker)
 * - GET  /oauth/callback  — OAuth redirect handler (postMessage bridge)
 * - POST /upload          — file upload endpoint
 *
 * The same server is passed to WsRpcServer so HTTP + WebSocket share one port.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface HttpServerOptions {
  port?: number
  host?: string
  uploadDir?: string
}

/**
 * Create and start an HTTP server. Returns the server instance
 * which can then be passed to WsRpcServer via `httpServer` option.
 */
export async function createHttpServer(options: HttpServerOptions = {}): Promise<Server> {
  const port = options.port ?? parseInt(process.env.PORT || process.env.CRAFT_RPC_PORT || '9100', 10)
  const host = options.host ?? process.env.CRAFT_RPC_HOST ?? '0.0.0.0'
  const dataDir = process.env.CRAFT_DATA_DIR ?? join(process.env.HOME || '/tmp', '.craft-agent')
  const uploadDir = options.uploadDir ?? join(dataDir, 'uploads')

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        handleHealth(res)
      } else if (url.pathname === '/oauth/callback' && req.method === 'GET') {
        handleOAuthCallback(url, res)
      } else if (url.pathname === '/upload' && req.method === 'POST') {
        await handleUpload(req, res, uploadDir)
      } else if (url.pathname === '/upload' && req.method === 'OPTIONS') {
        // CORS preflight
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        res.writeHead(204)
        res.end()
      } else {
        // Non-upgrade HTTP requests that don't match any route
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    } catch (err) {
      console.error('[http] Request error:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal server error' }))
      }
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      console.log(`[http] HTTP server listening on http://${host}:${port}`)
      resolve(server)
    })
  })
}

// ── Health Check ─────────────────────────────────────────────────────

function handleHealth(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }))
}

// ── OAuth Callback ───────────────────────────────────────────────────

function handleOAuthCallback(url: URL, res: ServerResponse): void {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  // Serve an HTML page that posts the OAuth result back to the opener (popup flow)
  const html = `<!DOCTYPE html>
<html>
<head><title>OAuth Complete</title></head>
<body>
<p>Completing authentication...</p>
<script>
(function() {
  var result = ${JSON.stringify({ code, state, error })};
  if (window.opener) {
    window.opener.postMessage({ type: 'oauth-callback', result: result }, '*');
    setTimeout(function() { window.close(); }, 1000);
  } else {
    document.body.innerHTML = '<p>Authentication complete. You can close this window.</p>';
  }
})();
</script>
</body>
</html>`

  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Cache-Control': 'no-store',
  })
  res.end(html)
}

// ── File Upload ──────────────────────────────────────────────────────

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  uploadDir: string,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')

  // Collect body
  const chunks: Buffer[] = []
  let totalSize = 0

  for await (const chunk of req) {
    totalSize += chunk.length
    if (totalSize > MAX_UPLOAD_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'File too large (max 50MB)' }))
      return
    }
    chunks.push(chunk)
  }

  const body = Buffer.concat(chunks)

  const contentType = req.headers['content-type'] || ''
  let filename: string
  let fileData: Buffer

  if (contentType.includes('multipart/form-data')) {
    const boundary = contentType.split('boundary=')[1]
    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing boundary in multipart request' }))
      return
    }

    const parsed = parseMultipart(body, boundary)
    if (!parsed) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Could not parse multipart data' }))
      return
    }

    filename = parsed.filename || `upload-${randomUUID()}`
    fileData = parsed.data
  } else {
    filename = `upload-${randomUUID()}`
    fileData = body
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const id = randomUUID().slice(0, 8)
  const finalName = `${id}-${safeName}`

  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true })
  }

  const filePath = join(uploadDir, finalName)
  writeFileSync(filePath, fileData)

  console.log(`[http] Uploaded file: ${finalName} (${fileData.length} bytes)`)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    success: true,
    filename: finalName,
    path: filePath,
    size: fileData.length,
  }))
}

// ── Multipart Parser (minimal) ──────────────────────────────────────

function parseMultipart(body: Buffer, boundary: string): { filename?: string; data: Buffer } | null {
  const boundaryBuf = Buffer.from(`--${boundary}`)
  const parts = splitBuffer(body, boundaryBuf)

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue

    const headers = part.subarray(0, headerEnd).toString()
    const data = part.subarray(headerEnd + 4)

    if (headers.includes('filename=')) {
      const match = headers.match(/filename="([^"]*)"/)
      const trimmed = data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a
        ? data.subarray(0, data.length - 2)
        : data

      return { filename: match?.[1], data: trimmed }
    }
  }

  return null
}

function splitBuffer(buf: Buffer, delimiter: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0

  while (start < buf.length) {
    const idx = buf.indexOf(delimiter, start)
    if (idx === -1) {
      parts.push(buf.subarray(start))
      break
    }
    if (idx > start) {
      parts.push(buf.subarray(start, idx))
    }
    start = idx + delimiter.length
  }

  return parts
}
