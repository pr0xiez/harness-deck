import { useEffect, useRef, useState } from 'react'
import type {
  McpEntry,
  McpHarness,
  McpInventory,
  McpMutation,
  McpServerInput,
  McpSource,
  McpTarget
} from '@shared/mcp'
import { useDeck } from '../store'
import { Field, Modal } from './ui'
import { Icon } from './Icon'

const api = window.harness
const harnessName = (name: McpHarness): string => (name === 'codex' ? 'Codex' : 'Claude Code')
const scopeName = (source: McpSource): string =>
  source.scope === 'user'
    ? 'User · all projects'
    : source.scope === 'local'
      ? 'Local · private to this project'
      : 'Project · shared configuration'

function stringMap(text: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined
  const value: unknown = JSON.parse(text)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== 'string')
  )
    throw new Error()
  return value as Record<string, string>
}

function ServerEditor({
  source,
  entry,
  harness,
  onClose,
  onSave
}: {
  source: McpSource
  entry?: McpEntry
  harness: McpHarness
  onClose: () => void
  onSave: (change: McpMutation) => Promise<string | null>
}): React.JSX.Element {
  const [name, setName] = useState(entry?.name ?? '')
  const [transport, setTransport] = useState<McpServerInput['transport']>(
    entry?.transport === 'http' || entry?.transport === 'sse' ? entry.transport : 'stdio'
  )
  const [endpoint, setEndpoint] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [headers, setHeaders] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (): Promise<void> => {
    if (busy) return
    let server: McpServerInput
    try {
      const parsedArgs: unknown = args.trim() ? JSON.parse(args) : undefined
      if (
        parsedArgs !== undefined &&
        (!Array.isArray(parsedArgs) || parsedArgs.some((v) => typeof v !== 'string'))
      )
        throw new Error()
      server = {
        name: name.trim(),
        transport,
        ...(endpoint.trim()
          ? transport === 'stdio'
            ? { command: endpoint.trim() }
            : { url: endpoint.trim() }
          : {}),
        ...(transport === 'stdio'
          ? {
              ...(parsedArgs !== undefined ? { args: parsedArgs as string[] } : {}),
              ...(env.trim() ? { env: stringMap(env) } : {})
            }
          : headers.trim()
            ? { headers: stringMap(headers) }
            : {})
      }
    } catch {
      setError(
        'Use a JSON array of strings for arguments and JSON objects with string values for environment variables and headers.'
      )
      return
    }
    setBusy(true)
    setError('')
    const message = await onSave({
      sourceId: source.id,
      revision: source.revision,
      ...(entry ? { action: 'edit', name: entry.name, server } : { action: 'add', server })
    })
    setBusy(false)
    if (message) setError(message)
    else onClose()
  }
  return (
    <Modal
      title={entry ? `Edit ${entry.name}` : 'Add MCP server'}
      wide
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <>
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || (!entry && !endpoint.trim())}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : 'Save server'}
          </button>
        </>
      }
    >
      <p className="mcp-muted">
        {harnessName(harness)} · {scopeName(source)}
      </p>
      <p className="mcp-path">{source.path}</p>
      {entry ? (
        <p className="mcp-muted">
          For privacy, existing command, URL and credential values are hidden. Leave a field blank
          to keep it. Supplied environment variables and headers update only the named keys; other
          values stay intact.
        </p>
      ) : null}
      <fieldset disabled={busy} className="mcp-fields">
        <Field label="Server name">
          <input
            autoFocus={!entry}
            aria-label="Server name"
            value={name}
            disabled={Boolean(entry)}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
          />
        </Field>
        <Field label="Transport">
          <select
            aria-label="Transport"
            value={transport}
            disabled={Boolean(entry)}
            onChange={(e) => setTransport(e.target.value as McpServerInput['transport'])}
          >
            <option value="stdio">Local command (stdio)</option>
            <option value="http">Streamable HTTP</option>
            {harness === 'claude' ? <option value="sse">SSE</option> : null}
          </select>
        </Field>
        <Field
          label={transport === 'stdio' ? 'Command' : 'Server URL'}
          hint={
            entry
              ? 'Blank keeps the existing value.'
              : transport === 'stdio'
                ? 'Enter the executable only; put arguments below.'
                : 'An HTTP or HTTPS MCP endpoint.'
          }
        >
          <input
            autoFocus={Boolean(entry)}
            aria-label={transport === 'stdio' ? 'Command' : 'Server URL'}
            autoComplete="off"
            spellCheck={false}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={
              entry
                ? 'Keep existing value'
                : transport === 'stdio'
                  ? 'npx'
                  : 'https://example.com/mcp'
            }
          />
        </Field>
        {transport === 'stdio' ? (
          <>
            <Field
              label="Arguments"
              hint="JSON array. Use [] to clear arguments; blank keeps existing values."
            >
              <textarea
                aria-label="Arguments"
                spellCheck={false}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={'["--option", "value"]'}
                rows={2}
              />
            </Field>
            <Field
              label="Environment variables"
              hint="JSON object. Named keys are added or replaced."
            >
              <textarea
                aria-label="Environment variables"
                autoComplete="off"
                spellCheck={false}
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                placeholder={'{"VARIABLE_NAME": "value"}'}
                rows={3}
              />
            </Field>
          </>
        ) : (
          <Field label="Headers" hint="JSON object. Named keys are added or replaced.">
            <textarea
              aria-label="Headers"
              autoComplete="off"
              spellCheck={false}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={'{"Header-Name": "value"}'}
              rows={3}
            />
          </Field>
        )}
      </fieldset>
      {source.scope === 'project' ? (
        <p className="mcp-muted">
          This file may be shared through version control. Prefer credential references supported by
          your harness.
        </p>
      ) : null}
      <p className="mcp-muted">
        Saving updates configuration. Reopen or reload the harness session to apply it; existing
        terminals keep running.
      </p>
      {error ? (
        <p role="alert" className="mcp-error">
          {error}
        </p>
      ) : null}
    </Modal>
  )
}

export function McpPage(): React.JSX.Element {
  const workspaces = useDeck((s) => s.workspaces)
  const activeId = useDeck((s) => s.activeWorkspaceId)
  const profiles = useDeck((s) => s.profiles)
  const platform = useDeck((s) => s.info?.platform)
  const setUi = useDeck((s) => s.setUi)
  const [harness, setHarness] = useState<McpHarness>('codex')
  const [environment, setEnvironment] = useState<McpTarget['environment']>('native')
  const [cwd, setCwd] = useState(() => workspaces.find((w) => w.id === activeId)?.cwd ?? '')
  const [inventory, setInventory] = useState<McpInventory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [destination, setDestination] = useState('')
  const [editor, setEditor] = useState<{ source: McpSource; entry?: McpEntry } | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const serial = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])
  useEffect(() => {
    const generation = ++serial.current
    setLoading(true)
    setError('')
    setInventory(null)
    setSelected(null)
    setEditor(null)
    void api.mcp
      .list({ harness, environment, ...(cwd ? { cwd } : {}) })
      .then((result) => {
        if (serial.current !== generation) return
        setInventory(result)
        setDestination(result.sources.find((source) => source.writable)?.id ?? '')
      })
      .catch(() => {
        if (serial.current === generation) setError('MCP discovery failed. Try refreshing.')
      })
      .finally(() => {
        if (serial.current === generation) setLoading(false)
      })
    return () => {
      serial.current++
    }
  }, [harness, environment, cwd, refresh])

  const save = async (mutation: McpMutation): Promise<string | null> => {
    if (busy) return 'Another change is being saved.'
    setBusy(true)
    setNotice('')
    setError('')
    try {
      const result = await api.mcp.mutate(mutation)
      if (!result.ok) return result.error
      setNotice(
        'Configuration saved. Reload or reopen the harness session to apply the change.'
      )
      setRefresh((value) => value + 1)
      return null
    } catch {
      return 'Unable to save. Refresh to check the source before trying again.'
    } finally {
      setBusy(false)
    }
  }
  const change = async (mutation: McpMutation): Promise<void> => {
    const message = await save(mutation)
    if (message) setError(message)
  }
  const entry = inventory?.entries.find((item) => item.id === selected)
  const source = inventory?.sources.find((item) => item.id === entry?.sourceId)
  const destinations = inventory?.sources.filter((item) => item.writable && !item.error) ?? []
  const installed = profiles.some(
    (profile) =>
      profile.id === `${environment === 'wsl' ? 'wsl:' : ''}${harness}` && profile.available
  )
  return (
    <main className="mcp-page" aria-label="MCP servers">
      <header className="mcp-page-head">
        <div>
          <p className="mcp-eyebrow">TOOLS & CONNECTIONS</p>
          <h1 ref={heading} tabIndex={-1}>
            MCPs
          </h1>
          <p className="mcp-muted">Manage the servers your coding harnesses can use.</p>
        </div>
        <div className="mcp-actions">
          <button
            className="btn"
            disabled={loading || busy || Boolean(editor)}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <Icon name="refresh" />
            Refresh
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setUi({ page: 'deck' })}>
            Back to workspace
          </button>
        </div>
      </header>
      <fieldset className="mcp-filters" disabled={busy || Boolean(editor)}>
        <label>
          Harness
          <select
            aria-label="Harness"
            value={harness}
            onChange={(e) => {
              setNotice('')
              setHarness(e.target.value as McpHarness)
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>
          Environment
          <select
            aria-label="Environment"
            value={environment}
            onChange={(e) => {
              setNotice('')
              setEnvironment(e.target.value as McpTarget['environment'])
            }}
          >
            <option value="native">Native{platform === 'linux' ? ' · Linux' : ''}</option>
            {platform === 'win32' ? <option value="wsl">WSL · default distribution</option> : null}
          </select>
        </label>
        <label className="mcp-project">
          Project
          <select
            aria-label="Project"
            value={cwd}
            onChange={(e) => {
              setNotice('')
              setCwd(e.target.value)
            }}
          >
            <option value="">User configuration only</option>
            {[...new Set([...workspaces.map((w) => w.cwd), cwd].filter(Boolean))].map((dir) => (
              <option key={dir} value={dir}>
                {dir}
              </option>
            ))}
          </select>
        </label>
        <button
          className="btn"
          onClick={() =>
            void api
              .pickDirectory(cwd)
              .then((dir) => {
                if (dir) {
                  setNotice('')
                  setCwd(dir)
                }
              })
              .catch(() => setError('Could not open the folder picker.'))
          }
        >
          <Icon name="folder" />
          Choose folder
        </button>
      </fieldset>
      {!installed ? (
        <p className="mcp-muted">
          {harnessName(harness)} was not detected in this environment. You can still inspect and
          prepare its configuration.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mcp-success">
          {notice}
        </p>
      ) : null}
      {error || inventory?.error ? (
        <p role="alert" className="mcp-error">
          {error || inventory?.error}
        </p>
      ) : null}
      {loading ? (
        <div className="mcp-empty" role="status">
          Reading MCP configuration…
        </div>
      ) : inventory && !inventory.error ? (
        <>
          <div className="mcp-section-head">
            <h2>
              Configured servers <span className="mcp-count">{inventory.entries.length}</span>
            </h2>
            {destinations.length ? (
              <div className="mcp-actions">
                <select
                  aria-label="New server scope"
                  value={destination}
                  disabled={busy}
                  onChange={(e) => setDestination(e.target.value)}
                >
                  {destinations.map((item) => (
                    <option value={item.id} key={item.id}>
                      {scopeName(item)}
                    </option>
                  ))}
                </select>
                <button
                  className="btn primary"
                  disabled={busy || !destination}
                  onClick={() => {
                    const item = destinations.find((s) => s.id === destination)
                    if (item) setEditor({ source: item })
                  }}
                >
                  <Icon name="plus" />
                  Add server
                </button>
              </div>
            ) : null}
          </div>
          <div className={`mcp-content ${entry ? 'has-details' : ''}`}>
            <div className="mcp-server-list">
              {inventory.entries.map((item) => {
                const origin = inventory.sources.find((s) => s.id === item.sourceId)!
                return (
                  <button
                    key={item.id}
                    className={`mcp-server ${selected === item.id ? 'selected' : ''}`}
                    onClick={() => setSelected(item.id)}
                    aria-pressed={selected === item.id}
                    aria-label={`${item.name} · ${scopeName(origin)} · ${item.transport}`}
                  >
                    <span className="mcp-server-mark">
                      <Icon name="command" />
                    </span>
                    <span className="mcp-server-description">
                      <strong>{item.name}</strong>
                      <span>{item.endpoint}</span>
                      <small>
                        {scopeName(origin)} · {item.transport.toUpperCase()}
                        {!origin.writable ? ' · Read-only' : ''}
                      </small>
                    </span>
                    <span className={`mcp-state ${item.enabled === false ? 'disabled' : ''}`}>
                      {item.enabled === false ? 'Disabled' : 'Configured'}
                    </span>
                  </button>
                )
              })}
              {!inventory.entries.length ? (
                <div className="mcp-empty">
                  <h3>
                    {inventory.sources.some((item) => item.error)
                      ? 'No servers found in readable sources'
                      : 'No MCP servers configured'}
                  </h3>
                  <p>
                    {destinations.length
                      ? 'Add a server for this harness, or choose another project or environment.'
                      : 'Choose another harness, project or environment.'}
                  </p>
                </div>
              ) : null}
            </div>
            {entry && source ? (
              <aside className="mcp-details" aria-label="Server details">
                <div className="mcp-section-head">
                  <h2>{entry.name}</h2>
                  <button
                    className="icon-btn"
                    title="Close details"
                    onClick={() => setSelected(null)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <dl>
                  <dt>Harness</dt>
                  <dd>
                    {harnessName(harness)} · {environment === 'wsl' ? 'WSL (default)' : 'Native'}
                  </dd>
                  <dt>Scope</dt>
                  <dd>{scopeName(source)}</dd>
                  <dt>Source</dt>
                  <dd className="mcp-path">{source.path}</dd>
                  <dt>Transport</dt>
                  <dd>{entry.transport.toUpperCase()}</dd>
                  <dt>Session connection</dt>
                  <dd>Not checked · view /mcp in your harness</dd>
                  <dt>Environment variables</dt>
                  <dd>{entry.environmentKeys.join(', ') || 'None configured'}</dd>
                  <dt>Headers</dt>
                  <dd>{entry.headerKeys.join(', ') || 'None configured'}</dd>
                </dl>
                <p className="mcp-muted">
                  Command arguments, URL paths and credential values are hidden.
                </p>
                {entry.issue ? <p className="mcp-muted">{entry.issue}</p> : null}
                <div className="mcp-actions">
                  {entry.canEdit ? (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => setEditor({ source, entry })}
                    >
                      Edit
                    </button>
                  ) : null}
                  {entry.canToggle ? (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void change({
                          action: 'toggle',
                          sourceId: source.id,
                          revision: source.revision,
                          name: entry.name,
                          enabled: entry.enabled === false
                        })
                      }
                    >
                      {entry.enabled === false ? 'Enable' : 'Disable'}
                    </button>
                  ) : null}
                  {entry.canEdit ? (
                    <button
                      className="btn danger"
                      disabled={busy}
                      onClick={() =>
                        void api
                          .confirm({
                            title: 'Remove MCP server',
                            message: `Remove “${entry.name}” from ${scopeName(source)}?`,
                            detail: source.path,
                            confirmLabel: 'Remove server'
                          })
                          .then((yes) => {
                            if (yes)
                              void change({
                                action: 'remove',
                                sourceId: source.id,
                                revision: source.revision,
                                name: entry.name
                              })
                          })
                          .catch(() => setError('Could not confirm removal.'))
                      }
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </aside>
            ) : null}
          </div>
          <details className="mcp-sources" open={inventory.sources.some((item) => item.error)}>
            <summary>Configuration sources ({inventory.sources.length})</summary>
            {inventory.sources.map((item) => (
              <div key={item.id}>
                <strong>
                  {scopeName(item)}
                  {!item.writable ? ' · Read-only' : ''}
                </strong>
                <p className="mcp-path">{item.path}</p>
                {item.error ? (
                  <p role="alert" className="mcp-error">
                    {item.error}
                  </p>
                ) : (
                  <p className="mcp-muted">
                    {item.revision === 'missing'
                      ? 'File does not exist yet.'
                      : 'Source read successfully.'}
                  </p>
                )}
              </div>
            ))}
          </details>
          <div className="mcp-notes">
            {inventory.notices.map((text) => (
              <p key={text}>{text}</p>
            ))}
            <p>OpenCode and other harnesses are not supported yet.</p>
            <button
              className="btn subtle"
              onClick={() =>
                api.openExternal(
                  harness === 'codex'
                    ? 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli'
                    : 'https://code.claude.com/docs/en/mcp'
                )
              }
            >
              MCP setup and authentication guide <Icon name="chevronRight" />
            </button>
          </div>
        </>
      ) : null}
      {editor ? (
        <ServerEditor
          source={editor.source}
          entry={editor.entry}
          harness={harness}
          onClose={() => setEditor(null)}
          onSave={save}
        />
      ) : null}
    </main>
  )
}
