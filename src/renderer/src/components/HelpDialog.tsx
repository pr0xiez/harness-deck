import { useDeck } from '../store'
import { Kbd, Modal } from './ui'

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  [
    'Workspaces',
    [
      ['Ctrl+1 … Ctrl+9', 'Switch to workspace by position'],
      ['Ctrl+Shift+N', 'New workspace'],
      ['Ctrl+Page Down / Page Up', 'Next / previous workspace']
    ]
  ],
  [
    'Panes',
    [
      ['Ctrl+Shift+T', 'New pane (harness picker)'],
      ['Ctrl+Shift+W', 'Close focused pane'],
      ['Ctrl+Shift+R', 'Restart the process in the focused pane'],
      ['Ctrl+Shift+Z', 'Zoom / restore the focused pane'],
      ['Alt+1 … Alt+9', 'Focus pane by position'],
      ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous pane'],
      ['Ctrl+Shift+← / →', 'Move the focused pane in the layout']
    ]
  ],
  [
    'Terminal',
    [
      ['Ctrl+Shift+C', 'Copy selection'],
      ['Ctrl+Shift+V', 'Paste'],
      ['Ctrl+Shift+F', 'Find in pane'],
      ['Ctrl+= / Ctrl+- / Ctrl+0', 'Font bigger / smaller / reset'],
      ['Ctrl+Shift+K', 'Clear the focused pane']
    ]
  ],
  [
    'App',
    [
      ['Ctrl+Shift+P', 'Command palette'],
      ['Ctrl+Shift+B', 'Broadcast a prompt to every pane'],
      ['Ctrl+Shift+,', 'Settings'],
      ['Ctrl+Shift+/', 'This help'],
      ['F12', 'Developer tools']
    ]
  ]
]

export function HelpDialog(): React.JSX.Element {
  const setUi = useDeck((s) => s.setUi)
  return (
    <Modal title="Keyboard shortcuts" wide onClose={() => setUi({ help: false })}>
      <p className="help-lead">
        Terminals get every plain key combination, so the app keeps to{' '}
        <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd> and <Kbd>Alt</Kbd>. On macOS use <Kbd>Cmd</Kbd> in place of{' '}
        <Kbd>Ctrl</Kbd>.
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
                      <Kbd>{keys}</Kbd>
                    </td>
                    <td>{description}</td>
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
