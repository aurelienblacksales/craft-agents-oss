#!/usr/bin/env bun
/**
 * Resilient entrypoint for Railway / Docker deployments.
 *
 * Starts a bare HTTP health server IMMEDIATELY (before any heavy imports)
 * so PaaS healthchecks pass while the full server bootstraps.
 *
 * The full server code is loaded via dynamic import — if it crashes during
 * module resolution or startup, the health endpoint stays alive and the
 * error is logged to stdout (visible in Railway runtime logs).
 */

import { createServer, type Server } from 'node:http'

const port = parseInt(process.env.CRAFT_RPC_PORT ?? process.env.PORT ?? '9100', 10)
const host = process.env.CRAFT_RPC_HOST ?? '0.0.0.0'

console.log(`[craft-server] entrypoint starting (host=${host}, port=${port})`)

// Start health endpoint IMMEDIATELY — zero heavy dependencies
const healthServer: Server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('{"status":"ok"}')
})

await new Promise<void>((resolve, reject) => {
  healthServer.on('error', (err) => {
    console.error('[craft-server] Health server failed to start:', err)
    reject(err)
  })
  healthServer.listen(port, host, () => {
    console.log(`[craft-server] Health endpoint listening on ${host}:${port}`)
    resolve()
  })
})

// Now dynamically import and boot the full server (heavy deps load here)
try {
  const { boot } = await import('./index.ts')
  await boot(healthServer)
  console.log('[craft-server] Full server boot complete')
} catch (error) {
  console.error('[craft-server] Fatal startup error:', error)
  // Health endpoint stays up so Railway doesn't kill the container.
  // The error is visible in Railway's runtime logs for debugging.
}
