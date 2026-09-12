/** MCP configuration inventory. Runtime connection state belongs to each harness session. */
export type McpHarness = 'codex' | 'claude'
export type McpScope = 'user' | 'project' | 'local'

export interface McpTarget {
  harness: McpHarness
  environment: 'native' | 'wsl'
  cwd?: string
}

export interface McpSource {
  id: string
  scope: McpScope
  path: string
  revision: string
  writable: boolean
  error?: string
}

export interface McpEntry {
  id: string
  sourceId: string
  name: string
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  enabled: boolean | null
  /** Display values only; credentials and command arguments are withheld. */
  endpoint: string
  environmentKeys: string[]
  headerKeys: string[]
  canEdit: boolean
  canToggle: boolean
  issue?: string
}

export interface McpInventory {
  target: McpTarget
  sources: McpSource[]
  entries: McpEntry[]
  notices: string[]
  error?: string
}

/** Fields omitted during an edit retain their original values in the main process. */
export interface McpServerInput {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
}

export type McpMutation = {
  sourceId: string
  revision: string
} & (
  | { action: 'add'; server: McpServerInput }
  | { action: 'edit'; name: string; server: McpServerInput }
  | { action: 'remove'; name: string }
  | { action: 'toggle'; name: string; enabled: boolean }
)

export type McpMutationResult = { ok: true } | { ok: false; error: string }
