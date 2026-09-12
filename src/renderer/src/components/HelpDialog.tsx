import { useDeck } from '../store'
import { Kbd, Modal } from './ui'

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  [
    'Workspaces',
    [
      ['Ctrl+1 … Ctrl+9', 'Switch to workspace by position'],
      ['Ctrl+Shift+N', 'New workspace'],
      ['Ctrl+Page Down / Page Up', 'Next / previous workspace'],
      ['Alt+Shift+1 … Alt+Shift+9', 'Run the workspace action at that position']
    ]
  ],
  [
    'Panes',
    [
      ['Ctrl+Shift+T', 'New pane (harness picker)'],
      ['Ctrl+Shift+W', 'Close focused pane'],
      ['Ctrl+Shift+R', 'Restart the focused pane; resume supported agent sessions'],
      ['Ctrl+Shift+Z', 'Zoom / restore the focused pane'],
      ['Ctrl+Shift+J', 'Jump to the next pane waiting for you'],
      ['Ctrl+Shift+U', 'The waiting queue — every pane waiting, and what it last said'],
      ['Alt+1 … Alt+9', 'Focus pane by position'],
      ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous pane'],
      ['Ctrl+Shift+← / →', 'Move the focused pane in the layout']
    ]
  ],
  [
    'Terminal',
    [
      ['Shift+drag', 'Select text even when the harness captures the mouse'],
      ['Ctrl+C', 'Copy selected text; interrupt when nothing is selected'],
      ['Ctrl+Shift+C', 'Copy selection'],
      ['Ctrl+Shift+V', 'Paste'],
      ['Ctrl+Shift+F', 'Find in pane'],
      ['Ctrl+Shift+Alt+F', 'Find across every pane in the workspace'],
      ['Ctrl+= / Ctrl+- / Ctrl+0', 'Font bigger / smaller / reset'],
      ['Ctrl+Shift+K', 'Clear the focused pane']
    ]
  ],
  [
    'App',
    [
      ['Ctrl+Shift+P', 'Command palette'],
      ['Ctrl+Shift+M', 'Dictate into the focused prompt (Esc discards)'],
      ['Ctrl+Shift+B', 'Broadcast a prompt to every pane'],
      ['Ctrl+Shift+E', 'Send the pane selection to the broadcast box, fenced'],
      ['Ctrl+Shift+,', 'Settings'],
      ['Ctrl+Shift+/', 'This help'],
      ['F12', 'Developer tools']
    ]
  ]
]

/** Rewrites the Windows/Linux chords above into their macOS equivalents. */
function forMac(keys: string): string {
  return keys
    .replace(/Ctrl\+/g, '⌘')
    .replace(/Shift\+/g, '⇧')
    .replace(/Alt\+/g, '⌥')
    .replace(/\bCtrl\b/g, '⌘')
    .replace(/\bAlt\b/g, '⌥')
    .replace(/\bF12\b/g, '⌘⌥I')
}

export function HelpDialog(): React.JSX.Element {
  const setUi = useDeck((s) => s.setUi)
  const isMac = useDeck((s) => s.info?.platform === 'darwin')
  return (
    <Modal title="Keyboard shortcuts" wide onClose={() => setUi({ help: false })}>
      <p className="help-lead">
        {isMac ? (
          <>
            Most app shortcuts use <Kbd>⌘</Kbd>
            <Kbd>⇧</Kbd> and <Kbd>⌥</Kbd>. <Kbd>⌘C</Kbd> and <Kbd>⌘V</Kbd> also work on a pane.
          </>
        ) : (
          <>
            Most app shortcuts use <Kbd>Ctrl</Kbd>+
            <Kbd>Shift</Kbd> and <Kbd>Alt</Kbd>.
          </>
        )}
      </p>
      <div className="help-grid">
        {SHORTCUTS.map(([group, rows]) => (
          <section key={group}>
            <h3>{group}</h3>
            <table>
              <tbody>
                {rows.map(([keys, description]) => (
                  <tr key={keys}>
                    <td>
                      <Kbd>{isMac ? forMac(keys === 'Shift+drag' ? 'Alt+drag' : keys) : keys}</Kbd>
                    </td>
                    <td>{isMac && keys === 'Ctrl+C' ? 'Copy selected text' : description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Modal>
  )
}
