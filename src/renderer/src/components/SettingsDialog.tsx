import { useEffect, useState } from 'react'
import type { UpdateChannel } from '@shared/types'
import { useDeck } from '../store'
import { DEFAULT_ATTENTION, DEFAULT_SETTINGS } from '../store'
import { Field, Modal, Toggle } from './ui'
import { Icon } from './Icon'
import { VoiceSettings } from './VoiceSettings'
import { OpenRouterKey } from './OpenRouterKey'

const api = window.harness

export function SettingsDialog(): React.JSX.Element {
  const settings = useDeck((s) => s.settings)
  const updateSettings = useDeck((s) => s.updateSettings)
  const updateAttention = useDeck((s) => s.updateAttention)
  const info = useDeck((s) => s.info)
  const profiles = useDeck((s) => s.profiles)
  const setUi = useDeck((s) => s.setUi)
  const update = useDeck((s) => s.update)
  const checkForUpdate = useDeck((s) => s.checkForUpdate)
  const installUpdate = useDeck((s) => s.installUpdate)
  const [stateFile, setStateFile] = useState('')

  useEffect(() => {
    void api.stateLocation().then(setStateFile)
  }, [])

  const installed = profiles.filter((p) => p.kind === 'agent' && p.available)
  const missing = profiles.filter((p) => p.kind === 'agent' && !p.available)

  return (
    <Modal
      title="Settings"
      wide
      onClose={() => setUi({ settings: false })}
      footer={
        <>
          <button className="btn ghost" onClick={() => updateSettings(DEFAULT_SETTINGS)}>
            Reset to defaults
          </button>
          <button className="btn primary" onClick={() => setUi({ settings: false })}>
            Done
          </button>
        </>
      }
    >
      <div className="settings-grid">
        <section>
          <h3>OpenRouter agents</h3>
          <p>Use the options button beside Claude Code or Codex when opening a pane to choose OpenRouter and a model.</p>
          <OpenRouterKey />
        </section>
        <section>
          <h3>MCP servers</h3>
          <p>Manage MCP configuration for your coding harnesses.</p>
          <button className="btn" onClick={() => setUi({ settings: false, page: 'mcps' })}>Manage MCPs</button>
        </section>
        <section>
          <h3>Terminal</h3>
          <Field label="Font size">
            <input
              type="number"
              min={8}
              max={28}
              value={settings.fontSize}
              onChange={(event) => updateSettings({ fontSize: Number(event.target.value) || 13 })}
            />
          </Field>
          <Field label="Font family" hint="Any font installed on this machine.">
            <input
              value={settings.fontFamily}
              onChange={(event) => updateSettings({ fontFamily: event.target.value })}
            />
          </Field>
          <Field label="Cursor">
            <select
              value={settings.cursorStyle}
              onChange={(event) =>
                updateSettings({ cursorStyle: event.target.value as typeof settings.cursorStyle })
              }
            >
              <option value="block">Block</option>
              <option value="bar">Bar</option>
              <option value="underline">Underline</option>
            </select>
          </Field>
          <Field label="Scrollback lines">
            <input
              type="number"
              min={500}
              max={200000}
              step={500}
              value={settings.scrollback}
              onChange={(event) => updateSettings({ scrollback: Number(event.target.value) || 8000 })}
            />
          </Field>
          <Toggle
            label="Blinking cursor"
            checked={settings.cursorBlink}
            onChange={(cursorBlink) => updateSettings({ cursorBlink })}
          />
          <Toggle
            label="Copy on selection"
            checked={settings.copyOnSelect}
            onChange={(copyOnSelect) => updateSettings({ copyOnSelect })}
          />
        </section>

        <section>
          <h3>Behaviour</h3>
          <Field label="Default folder for new workspaces">
            <div className="row">
              <input
                value={settings.defaultCwd}
                onChange={(event) => updateSettings({ defaultCwd: event.target.value })}
              />
              <button
                className="btn subtle"
                onClick={async () => {
                  const dir = await api.pickDirectory(settings.defaultCwd)
                  if (dir) updateSettings({ defaultCwd: dir })
                }}
              >
                <Icon name="folder" />
              </button>
            </div>
          </Field>
          <Toggle
            label="Start panes automatically"
            hint="When off, restored panes wait for you to press Start."
            checked={settings.autoStartPanes}
            onChange={(autoStartPanes) => updateSettings({ autoStartPanes })}
          />
          <Toggle
            label="Confirm before closing a running pane"
            checked={settings.confirmCloseRunning}
            onChange={(confirmCloseRunning) => updateSettings({ confirmCloseRunning })}
          />
        </section>

        <section>
          <h3>Attention</h3>
          <Field
            label="Quiet time before a pane counts as waiting"
            hint="Milliseconds of silence from a running process. Lower catches an agent at a prompt sooner; higher stops a slow thinker looking finished."
          >
            <input
              type="number"
              min={500}
              max={60000}
              step={250}
              value={settings.attention.quietMs}
              onChange={(event) =>
                updateAttention({ quietMs: Number(event.target.value) || DEFAULT_ATTENTION.quietMs })
              }
            />
          </Field>
          <Toggle
            label="Count waiting panes on the app icon"
            hint="A dock badge on macOS and Linux; a flashing taskbar button on Windows."
            checked={settings.attention.badge}
            onChange={(badge) => updateAttention({ badge })}
          />
        </section>

        <section className="settings-wide">
          <h3>Detected harnesses</h3>
          <div className="detect-list">
            {installed.map((profile) => (
              <div key={profile.id} className="detect-row ok">
                <span className="profile-badge" style={{ ['--badge' as string]: profile.accent }}>
                  {profile.icon}
                </span>
                <span className="detect-name">{profile.name}</span>
                <code className="detect-path">{profile.detail}</code>
              </div>
            ))}
            {missing.map((profile) => (
              <div key={profile.id} className="detect-row">
                <span className="profile-badge ghost">{profile.icon}</span>
                <span className="detect-name">{profile.name}</span>
                <code className="detect-path">{profile.detail}</code>
              </div>
            ))}
          </div>
          <button className="btn subtle" onClick={() => void useDeck.getState().refreshProfiles()}>
            <Icon name="refresh" />
            <span>Rescan</span>
          </button>
        </section>

        <VoiceSettings />

        <section className="settings-wide">
          <h3>Updates</h3>
          <Field
            label="Release channel"
            hint="GitHub releases is the only one that reaches the network."
          >
            <select
              value={settings.updateChannel}
              onChange={(event) =>
                updateSettings({ updateChannel: event.target.value as UpdateChannel })
              }
            >
              <option value="local">Local manifest</option>
              <option value="github">GitHub releases</option>
              <option value="off">Off</option>
            </select>
          </Field>
          <div className="detect-list">
            <div className={`detect-row ${update?.stage === 'available' ? 'ok' : ''}`}>
              <span className="detect-name">
                {settings.updateChannel === 'off'
                  ? `Not checking for updates — running ${update?.current ?? info?.versions.app}`
                  : update?.stage === 'available' && update.available
                    ? `Version ${update.available.version} is ready to install`
                    : update?.stage === 'error'
                      ? update.error
                      : `Up to date on ${update?.current ?? info?.versions.app}`}
              </span>
              <code className="detect-path">
                {update?.lastCheckedAt
                  ? `checked ${new Date(update.lastCheckedAt).toLocaleTimeString()}`
                  : 'not checked yet'}
              </code>
            </div>
          </div>
          <div className="row">
            <button
              className="btn subtle"
              disabled={settings.updateChannel === 'off'}
              onClick={() => void checkForUpdate()}
            >
              <Icon name="refresh" />
              <span>Check now</span>
            </button>
            {update?.stage === 'available' && update.installable ? (
              <button className="btn primary" onClick={() => void installUpdate()}>
                <Icon name="restart" />
                <span>Restart &amp; install</span>
              </button>
            ) : null}
          </div>
          {settings.updateChannel === 'github' ? (
            <span className="field-hint">
              Releases are picked up from <code>{update?.feedUrl || 'nowhere — see package.json'}</code>
            </span>
          ) : settings.updateChannel === 'local' ? (
            <span className="field-hint">
              Releases are picked up from{' '}
              <button
                className="link"
                onClick={() => api.openPath(update?.manifestPath ?? '')}
                title={update?.manifestPath}
              >
                {update?.manifestPath}
              </button>
            </span>
          ) : null}
        </section>

        <section className="settings-wide muted">
          <h3>About</h3>
          <p>
            Harness Deck {info?.versions.app} · Electron {info?.versions.electron} · Chromium{' '}
            {info?.versions.chrome} · Node {info?.versions.node} · {info?.platform}
          </p>
          <p>
            Login shell: <code>{info?.defaultShell}</code>
          </p>
          <p>
            Layout file:{' '}
            <button className="link" onClick={() => api.openPath(stateFile)} title={stateFile}>
              {stateFile}
            </button>
          </p>
        </section>
      </div>
    </Modal>
  )
}
