/**
 * Web Bootstrap — Auto-provision workspace and LLM connection from env vars.
 *
 * When ANTHROPIC_API_KEY is set, automatically:
 * 1. Creates a default workspace (if none exists)
 * 2. Creates a Claude LLM connection with the API key
 * 3. Sets default permission mode to 'allow-all' for web sessions
 *
 * This allows the web app to be immediately usable without onboarding.
 */

import { loadStoredConfig, saveConfig, addWorkspace, setActiveWorkspace } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { saveLlmConnection, setDefaultLlmConnection, getLlmConnection } from '@craft-agent/shared/config/llm-connections'
import type { LlmConnection } from '@craft-agent/shared/config/llm-connections'
import { loadWorkspaceConfig, saveWorkspaceConfig } from '@craft-agent/shared/workspaces'

const WEB_WORKSPACE_NAME = 'Default Workspace'
const CLAUDE_CONNECTION_SLUG = 'claude-api'

export async function webBootstrap(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    console.log('[web-bootstrap] No ANTHROPIC_API_KEY set, skipping auto-provision')
    return
  }

  const config = loadStoredConfig()
  if (!config) {
    console.warn('[web-bootstrap] No global config found, skipping')
    return
  }

  // 1. Ensure at least one workspace exists
  let workspaceId = config.activeWorkspaceId
  if (!workspaceId || config.workspaces.length === 0) {
    console.log('[web-bootstrap] Creating default workspace...')
    const dataDir = process.env.CRAFT_DATA_DIR || (await getDefaultDataDir())
    const workspace = addWorkspace({ name: WEB_WORKSPACE_NAME, rootPath: dataDir })
    setActiveWorkspace(workspace.id)
    workspaceId = workspace.id
    console.log(`[web-bootstrap] Created workspace "${WEB_WORKSPACE_NAME}" (${workspace.id})`)
  } else {
    console.log(`[web-bootstrap] Using existing workspace: ${workspaceId}`)
  }

  // 2. Ensure Claude LLM connection exists with the API key
  const existingConnection = getLlmConnection(CLAUDE_CONNECTION_SLUG)
  if (!existingConnection) {
    console.log('[web-bootstrap] Creating Claude API connection...')
    const connection: LlmConnection = {
      slug: CLAUDE_CONNECTION_SLUG,
      name: 'Claude (API Key)',
      provider: 'anthropic',
      authType: 'api-key',
      model: 'claude-sonnet-4-20250514',
      isDefault: true,
    }
    saveLlmConnection(connection)
    setDefaultLlmConnection(CLAUDE_CONNECTION_SLUG)
    console.log('[web-bootstrap] Created Claude API connection')
  }

  // 3. Store the API key in credentials
  try {
    const manager = getCredentialManager()
    await manager.setLlmApiKey(CLAUDE_CONNECTION_SLUG, apiKey)
    console.log('[web-bootstrap] Stored API key in credential manager')
  } catch (err) {
    console.error('[web-bootstrap] Failed to store API key:', err)
  }

  // 4. Set default permission mode to allow-all for web sessions
  // and set the default LLM connection on the workspace
  try {
    const updatedConfig = loadStoredConfig()
    if (updatedConfig) {
      const workspace = updatedConfig.workspaces.find(w => w.id === workspaceId)
      if (workspace) {
        const wsConfig = loadWorkspaceConfig(workspace.rootPath)
        if (wsConfig) {
          wsConfig.defaults = {
            ...wsConfig.defaults,
            permissionMode: 'allow-all',
            cyclablePermissionModes: ['allow-all'],
            defaultLlmConnection: CLAUDE_CONNECTION_SLUG,
          }
          saveWorkspaceConfig(workspace.rootPath, wsConfig)
          console.log('[web-bootstrap] Set workspace permissionMode=allow-all, defaultLlmConnection=claude-api')
        }
      }
    }
  } catch (err) {
    console.warn('[web-bootstrap] Failed to update workspace defaults:', err)
  }

  console.log('[web-bootstrap] Web bootstrap complete')
}

async function getDefaultDataDir(): Promise<string> {
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  return join(homedir(), '.craft-agent')
}
