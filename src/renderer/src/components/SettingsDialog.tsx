import { useEffect, useState } from 'react'
import { useDeck } from '../store'
import { DEFAULT_SETTINGS } from '../store'
import { Field, Modal, Toggle } from './ui'
import { Icon } from './Icon'

const api = window.harness

export function SettingsDialog(): React.JSX.Element {
  const settings = useDeck((s) => s.settings)
  const updateSettings = useDeck((s) => s.updateSettings)
  const info = useDeck((s) => s.info)
  const profiles = useDeck((s) => s.profiles)
  const setUi = useDeck((s) => s.setUi)
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
          <Toggle
            label="Notify on terminal bell"
            hint="Agents ring the bell when they need you."
            checked={settings.bellNotifications}
            onChange={(bellNotifications) => updateSettings({ bellNotifications })}
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
