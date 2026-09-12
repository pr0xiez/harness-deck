import { applyEdits, modify, parse, parseTree, type ParseError, type Node } from 'jsonc-parser'
import { getStaticTOMLValue, parseTOML, type AST } from 'toml-eslint-parser'
import type { McpEntry, McpHarness, McpMutation, McpScope, McpServerInput } from '@shared/mcp'

type RecordValue = Record<string, unknown>
export function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
const owns = (value: object, key: string): boolean => Object.hasOwn(value, key)
const prefix = (a: (string | number)[], b: (string | number)[]): boolean =>
  a.length <= b.length && a.every((part, index) => part === b[index])
const same = (a: (string | number)[], b: (string | number)[]): boolean =>
  a.length === b.length && prefix(a, b)
const astFor = (text: string): AST.TOMLProgram => parseTOML(text, { tomlVersion: '1.0' })

/** Duplicate JSON keys are ambiguous to edit, even though JSON.parse accepts them. */
function checkDuplicates(node: Node | undefined): void {
  if (!node) return
  if (node.type === 'object') {
    const seen = new Set<string>()
    for (const child of node.children ?? []) {
      const key = String(child.children?.[0].value)
      if (seen.has(key))
        throw new Error(
          'Configuration contains duplicate keys. Resolve them in the source file first.'
        )
      seen.add(key)
    }
  }
  for (const child of node.children ?? []) checkDuplicates(child)
}

export function configValue(text: string, harness: McpHarness): RecordValue {
  try {
    if (harness === 'codex') return getStaticTOMLValue(astFor(text)) as RecordValue
    if (!text.trim()) return {}
    const errors: ParseError[] = []
    const value: unknown = parse(text, errors, {
      allowTrailingComma: false,
      disallowComments: true
    })
    if (errors.length || !record(value)) throw new Error()
    checkDuplicates(parseTree(text))
    return value
  } catch {
    // Parser messages can include literal tokens from a secret-bearing document.
    throw new Error(
      'Configuration is malformed or contains duplicate keys. Fix the source file and refresh.'
    )
  }
}

export function serverPath(harness: McpHarness, scope: McpScope, cwd?: string): string[] {
  return harness === 'codex'
    ? ['mcp_servers']
    : scope === 'local'
      ? ['projects', cwd ?? '', 'mcpServers']
      : ['mcpServers']
}

function atPath(root: RecordValue, path: string[]): unknown {
  let value: unknown = root
  for (const key of path) {
    if (!record(value)) throw new Error('Unsupported configuration structure.')
    if (!owns(value, key)) return undefined
    value = value[key]
  }
  return value
}

export function serversFor(
  text: string,
  harness: McpHarness,
  scope: McpScope,
  cwd?: string
): RecordValue {
  const value = atPath(configValue(text, harness), serverPath(harness, scope, cwd))
  if (value === undefined) return {}
  if (!record(value)) throw new Error('The MCP server map has an unsupported structure.')
  return value
}

function standardTable(text: string, name: string): AST.TOMLTable | undefined {
  return astFor(text).body[0].body.find(
    (node): node is AST.TOMLTable =>
      node.type === 'TOMLTable' &&
      node.kind === 'standard' &&
      same(node.resolvedKey, ['mcp_servers', name])
  )
}

/** Only the origin is displayed: URL paths, queries and userinfo can all contain secrets. */
export function displayEndpoint(server: RecordValue): string {
  if (typeof server.url === 'string') {
    try {
      const url = new URL(server.url)
      return ['http:', 'https:'].includes(url.protocol)
        ? `${url.protocol}//${url.host}/…`
        : 'URL hidden'
    } catch {
      return 'Invalid URL'
    }
  }
  return typeof server.command === 'string'
    ? 'Local command (values hidden)'
    : 'Unknown configuration'
}

export function inventoryEntries(
  text: string,
  harness: McpHarness,
  scope: McpScope,
  sourceId: string,
  writable: boolean,
  cwd?: string
): McpEntry[] {
  const servers = serversFor(text, harness, scope, cwd)
  const standardNames = new Set(
    harness === 'codex'
      ? astFor(text)
          .body[0].body.filter(
            (node): node is AST.TOMLTable =>
              node.type === 'TOMLTable' &&
              node.kind === 'standard' &&
              node.resolvedKey.length === 2 &&
              node.resolvedKey[0] === 'mcp_servers'
          )
          .map((node) => String(node.resolvedKey[1]))
      : []
  )
  return Object.entries(servers).map(([name, raw]) => {
    const value = record(raw) ? raw : {}
    const transport =
      typeof value.command === 'string' && !value.url
        ? 'stdio'
        : typeof value.url === 'string' && !value.command
          ? value.type === 'sse'
            ? 'sse'
            : 'http'
          : 'unknown'
    const supported =
      transport !== 'unknown' &&
      (value.type === undefined || ['stdio', 'http', 'sse'].includes(String(value.type))) &&
      (harness === 'claude' || standardNames.has(name))
    return {
      id: `${sourceId}:${name}`,
      sourceId,
      name,
      transport,
      enabled:
        harness === 'codex'
          ? typeof value.enabled === 'boolean'
            ? value.enabled
            : value.enabled === undefined
              ? true
              : null
          : null,
      endpoint: displayEndpoint(value),
      environmentKeys: record(value.env) ? Object.keys(value.env) : [],
      headerKeys: record(value.headers ?? value.http_headers)
        ? Object.keys((value.headers ?? value.http_headers) as object)
        : [],
      canEdit: writable && supported,
      canToggle: writable && supported && harness === 'codex',
      ...(!supported
        ? {
            issue:
              'This definition can be viewed here; its layout or transport requires editing in the source file.'
          }
        : {})
    }
  })
}

function validString(value: unknown, limit = 16000): value is string {
  return typeof value === 'string' && value.length <= limit && !value.includes('\0')
}
function validateInput(input: McpServerInput, adding: boolean): void {
  if (
    !record(input) ||
    !validString(input.name, 128) ||
    (adding && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.name))
  ) {
    throw new Error('Use a server name containing letters, numbers, dots, underscores or hyphens.')
  }
  if (!['stdio', 'http', 'sse'].includes(input.transport)) throw new Error('Unsupported transport.')
  if (input.command !== undefined && (!validString(input.command) || !input.command.trim()))
    throw new Error('Enter a command.')
  if (input.url !== undefined) {
    if (!validString(input.url)) throw new Error('Enter a valid HTTP or HTTPS URL.')
    try {
      if (!['http:', 'https:'].includes(new URL(input.url).protocol)) throw new Error()
    } catch {
      throw new Error('Enter a valid HTTP or HTTPS URL.')
    }
  }
  if (
    input.args !== undefined &&
    (!Array.isArray(input.args) ||
      input.args.length > 256 ||
      !input.args.every((v) => validString(v)))
  ) {
    throw new Error('Arguments must be an array of strings (up to 256).')
  }
  for (const map of [input.env, input.headers]) {
    if (map === undefined) continue
    if (
      !record(map) ||
      Object.keys(map).length > 128 ||
      Object.entries(map).some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ||
          !validString(value) ||
          ['__proto__', 'constructor', 'prototype'].includes(key)
      )
    ) {
      throw new Error(
        'Environment variables and headers must be objects with valid names and string values.'
      )
    }
  }
  if (input.transport === 'stdio' && (input.url !== undefined || input.headers !== undefined))
    throw new Error('A stdio server uses command, arguments and environment variables.')
  if (
    input.transport !== 'stdio' &&
    (input.command !== undefined || input.args !== undefined || input.env !== undefined)
  )
    throw new Error('An HTTP server uses a URL and headers.')
  if (adding && (input.transport === 'stdio' ? !input.command : !input.url))
    throw new Error('Enter the command or URL for the new server.')
}

function tomlLiteral(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value).replace(/\u007f/g, '\\u007f')
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlLiteral).join(', ')}]`
  throw new Error('Unsupported value.')
}

/** Replace only a value span. All other bytes, including comments, stay intact. */
function setToml(text: string, path: string[], value: unknown): string {
  const ast = astFor(text)
  const leaves: { path: string[]; node: AST.TOMLKeyValue }[] = []
  const walk = (nodes: AST.TOMLKeyValue[], base: string[]): void => {
    for (const node of nodes) {
      const full = [...base, ...getStaticTOMLValue(node.key)]
      leaves.push({ path: full, node })
      if (node.value.type === 'TOMLInlineTable') walk(node.value.body, full)
    }
  }
  for (const node of ast.body[0].body) {
    if (node.type === 'TOMLKeyValue') walk([node], [])
    else if (node.kind === 'standard') walk(node.body, node.resolvedKey.map(String))
  }
  const existing = leaves.find((leaf) => same(leaf.path, path))
  if (existing)
    return (
      text.slice(0, existing.node.value.range[0]) +
      tomlLiteral(value) +
      text.slice(existing.node.value.range[1])
    )
  if (leaves.some((leaf) => prefix(leaf.path, path))) {
    throw new Error(
      'Adding a field inside an inline table is not supported. Edit that field in the source file.'
    )
  }
  const table = ast.body[0].body
    .filter(
      (node): node is AST.TOMLTable =>
        node.type === 'TOMLTable' && node.kind === 'standard' && prefix(node.resolvedKey, path)
    )
    .sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0]
  if (!table) throw new Error('This TOML layout requires editing in the source file.')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  // End of the table's last statement, including its trailing inline comment.
  const lineEnd = text.indexOf('\n', table.range[1])
  const offset = lineEnd < 0 ? text.length : lineEnd + 1
  const key = path.slice(table.resolvedKey.length).map(tomlLiteral).join('.')
  const insert = `${offset && text[offset - 1] !== '\n' ? eol : ''}${key} = ${tomlLiteral(value)}${eol}`
  return text.slice(0, offset) + insert + text.slice(offset)
}

/** Pure, format-preserving edit. The caller owns validation of the source revision and IO. */
export function editConfig(
  text: string,
  harness: McpHarness,
  scope: McpScope,
  mutation: McpMutation,
  cwd?: string
): string {
  const servers = serversFor(text, harness, scope, cwd)
  const adding = mutation.action === 'add'
  const name = adding ? mutation.server.name : mutation.name
  if (!validString(name, 128) || ['__proto__', 'constructor', 'prototype'].includes(name))
    throw new Error('Invalid server name.')
  if (adding ? owns(servers, name) : !owns(servers, name))
    throw new Error(
      adding
        ? 'A server with this name already exists in this source.'
        : 'This server no longer exists. Refresh and try again.'
    )
  if (!adding && harness === 'codex' && !standardTable(text, name))
    throw new Error('This TOML layout requires editing in the source file.')
  const old = adding ? {} : servers[name]
  if (!record(old)) throw new Error('Unsupported server definition.')
  if (
    mutation.action === 'toggle' &&
    (harness !== 'codex' || typeof mutation.enabled !== 'boolean')
  )
    throw new Error('Enable/disable is not supported for this source.')
  const path = [...serverPath(harness, scope, cwd), name]
  const changes: { path: string[]; value: unknown }[] = []
  if (mutation.action === 'toggle')
    changes.push({ path: [...path, 'enabled'], value: mutation.enabled })
  if (mutation.action === 'add' || mutation.action === 'edit') {
    const input = mutation.server
    validateInput(input, adding)
    if (input.name !== name) throw new Error('Rename is not supported. Add a new server instead.')
    if (harness === 'codex' && input.transport === 'sse')
      throw new Error('Codex supports stdio and Streamable HTTP here.')
    if (!adding) {
      const oldTransport =
        typeof old.command === 'string' ? 'stdio' : old.type === 'sse' ? 'sse' : 'http'
      if (oldTransport !== input.transport)
        throw new Error('To change transport, add a new server.')
    }
    if (adding && harness === 'claude')
      changes.push({ path: [...path, 'type'], value: input.transport })
    for (const key of ['command', 'args', 'url'] as const) {
      if (input[key] !== undefined) changes.push({ path: [...path, key], value: input[key] })
    }
    for (const [field, map] of [
      ['env', input.env],
      [harness === 'codex' ? 'http_headers' : 'headers', input.headers]
    ] as const) {
      for (const [key, value] of Object.entries(map ?? {}))
        changes.push({ path: [...path, field, key], value })
    }
  }
  let next = text
  if (harness === 'claude') {
    const indentation = text.match(/\n([\t ]+)"/)?.[1]
    const options = {
      formattingOptions: {
        insertSpaces: !indentation?.includes('\t'),
        tabSize: indentation?.length || 2,
        eol: text.includes('\r\n') ? '\r\n' : '\n'
      }
    }
    if (mutation.action === 'remove')
      next = applyEdits(next, modify(next, path, undefined, options))
    else
      for (const change of changes)
        next = applyEdits(
          next || '{}\n',
          modify(next || '{}\n', change.path, change.value, options)
        )
  } else if (mutation.action === 'remove') {
    const tables = astFor(text).body[0].body.filter(
      (node): node is AST.TOMLTable => node.type === 'TOMLTable' && prefix(path, node.resolvedKey)
    )
    for (const table of tables.reverse())
      next = next.slice(0, table.range[0]) + next.slice(table.range[1])
  } else {
    if (adding) {
      const eol = text.includes('\r\n') ? '\r\n' : '\n'
      next += `${eol}[mcp_servers.${tomlLiteral(name)}]${eol}`
    }
    for (const change of changes) next = setToml(next, change.path, change.value)
  }
  // Reject edits that would collide with a dotted/inline table or an unsupported schema.
  serversFor(next, harness, scope, cwd)
  return next
}
