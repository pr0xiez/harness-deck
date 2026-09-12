#!/usr/bin/env node
// Also runs under the bundled Electron runtime with ELECTRON_RUN_AS_NODE=1.
const { readFileSync } = require('node:fs')
const http = require('node:http')
async function main() {
  const args = process.argv.slice(2)
  const options = {}
  const positional = []
  for (let n = 0; n < args.length; n++) {
    if (args[n].startsWith('--')) {
      const key = args[n].slice(2)
      if (key === 'help') { options.help = true; continue }
      if (!['discovery', 'title', 'description', 'description-file', 'status', 'workspace', 'revision'].includes(key) || options[key] !== undefined || args[n + 1] === undefined) throw Error(`Invalid option: ${args[n]}`)
      options[key] = args[++n]
    } else positional.push(args[n])
  }
  const [command, id] = positional
  if (options.help || !command) {
    return { ok: true, usage: ['hd-work list [--status ideas|in_progress|wont_do|done] [--workspace <id>|unassigned]', 'hd-work get <id>', 'hd-work create --title <text> [--description <text>|--description-file <path>] [--status <status>] [--workspace <id>|unassigned]', 'hd-work edit <id> --revision <n> [--title <text>] [--description <text>|--description-file <path>] [--workspace <id>|unassigned]', 'hd-work move <id> --revision <n> --status <status>'], note: 'Deck must be running with harness access enabled. Get the current revision before editing. Status changes are explicit; move to done only when the work is complete.' }
  }
  if (!['list', 'get', 'create', 'edit', 'move'].includes(command) || positional.length > (['get', 'edit', 'move'].includes(command) ? 2 : 1)) throw Error('Unknown command or extra arguments. Use --help.')
  if (['get', 'edit', 'move'].includes(command) && !id) throw Error('A card ID is required.')
  const allowed = { list: ['status', 'workspace'], get: [], create: ['title', 'description', 'description-file', 'status', 'workspace'], edit: ['revision', 'title', 'description', 'description-file', 'workspace'], move: ['revision', 'status'] }[command]
  for (const key of Object.keys(options)) if (key !== 'discovery' && !allowed.includes(key)) throw Error(`--${key} is not supported for ${command}.`)
  if (options['description-file'] !== undefined) {
    if (options.description !== undefined) throw Error('Use either --description or --description-file.')
    options.description = readFileSync(options['description-file'], 'utf8')
  }
  const discovery = options.discovery || process.env.HD_WORK_DISCOVERY
  if (!discovery) throw Error('No Deck connection. Open Board in Deck and use its CLI path.')
  let config
  try { config = JSON.parse(readFileSync(discovery, 'utf8')) } catch { throw Error('Deck is unavailable. Start Deck and enable harness access on Board.') }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== 'string') throw Error('Invalid Deck connection file.')
  let payload
  if (['create', 'edit', 'move'].includes(command)) {
    payload = { operation: command }
    if (command !== 'create') {
      if (!/^[1-9]\d*$/.test(options.revision || '')) throw Error('--revision must be the current card revision. Use get first.')
      payload.id = id
      payload.expectedRevision = Number(options.revision)
    }
    for (const field of ['title', 'description', 'status']) if (options[field] !== undefined) payload[field] = options[field]
    const ws = options.workspace ?? (command === 'create' ? process.env.HD_WORK_WORKSPACE : undefined)
    if (ws !== undefined) payload.workspaceId = ws === 'unassigned' ? null : ws
  }
  const body = payload ? JSON.stringify(payload) : undefined
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: config.port, path: '/board', method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${config.token}`, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(Error('Invalid response from Deck.')) } })
      res.on('error', reject)
    })
    req.setTimeout(10000, () => req.destroy(Error('Deck request timed out. Check list/get before retrying a mutation.')))
    req.on('error', reject)
    req.end(body)
  })
  if (!result.ok) return result
  if (command === 'get') {
    const item = result.board.items.find(item => item.id === id)
    return item ? { ok: true, item } : { ok: false, code: 'not_found', error: 'Card not found.' }
  }
  if (command === 'list') {
    if (options.status && !['ideas', 'in_progress', 'wont_do', 'done'].includes(options.status)) throw Error('Invalid status.')
    return { ok: true, items: result.board.items.filter(item => (!options.status || item.status === options.status) && (options.workspace === undefined || item.workspaceId === (options.workspace === 'unassigned' ? null : options.workspace))) }
  }
  return { ok: true, item: result.item }
}
main().then(result => { process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.ok ? 0 : 1 }).catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1 })
