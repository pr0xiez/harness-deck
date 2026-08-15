import { shortcutLabel } from '../shortcuts'
import { useDeck } from '../store'
import { Kbd, Modal } from './ui'

const chord = shortcutLabel

/** A digit chord shown as its whole range: 'Alt+1 … Alt+9'. */
const range = (id: Parameters<typeof shortcutLabel>[0]): string =>
  `${chord(id, 1)} … ${chord(id, 9)}`

/**
 * Grouping, order and prose are display concerns and stay here; every chord
 * string comes off the shortcut table, so the help can no longer promise a
 * combo the matcher does not answer. F12 stays a literal — the devtools
 * binding belongs to the main process, not to SHORTCUTS.
 */
const SHORTCUT_GROUPS: Array<[string, Array<[string, string]>]> = [
  [
    'Workspaces',
    [
      [range('workspace-by-digit'), 'Switch to workspace by position'],
      [chord('new-workspace'), 'New workspace'],
      [`${chord('next-workspace')} / ${chord('prev-workspace')}`, 'Next / previous workspace'],
      [range('run-action-by-digit'), 'Run the workspace action at that position']
    ]
  ],
  [
    'Panes',
    [
      [chord('new-pane'), 'New pane (harness picker)'],
      [chord('close-pane'), 'Close focused pane'],
      [chord('restart-pane'), 'Restart the process in the focused pane'],
      [chord('zoom-pane'), 'Zoom / restore the focused pane'],
      [chord('focus-waiting'), 'Jump to the next pane waiting for you'],
      [
        chord('toggle-waiting-queue'),
        'The waiting queue — every pane waiting, and what it last said'
      ],
      [range('focus-pane-by-digit'), 'Focus pane by position'],
      [`${chord('next-pane')} / ${chord('prev-pane')}`, 'Next / previous pane'],
      [
        `${chord('move-pane-left')} / ${chord('move-pane-right')}`,
        'Move the focused pane in the layout'
      ]
    ]
  ],
  [
    'Terminal',
    [
      [chord('copy-selection'), 'Copy selection'],
      [chord('paste'), 'Paste'],
      [chord('find-pane'), 'Find in pane'],
      [chord('find-all'), 'Find across every pane in the workspace'],
      [
        `${chord('font-bigger')} / ${chord('font-smaller')} / ${chord('font-reset')}`,
        'Font bigger / smaller / reset'
      ],
      [chord('clear-pane'), 'Clear the focused pane']
    ]
  ],
  [
    'App',
    [
      [chord('toggle-palette'), 'Command palette'],
      [chord('toggle-dictation'), 'Dictate into the focused prompt (Esc discards)'],
      [chord('toggle-broadcast'), 'Broadcast a prompt to every pane'],
      [chord('send-selection'), 'Send the pane selection to the broadcast box, fenced'],
      [chord('open-settings'), 'Settings'],
      [chord('open-help'), 'This help'],
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
            Terminals get every plain key combination, so the app keeps to <Kbd>⌘</Kbd>
            <Kbd>⇧</Kbd> and <Kbd>⌥</Kbd>. <Kbd>⌘C</Kbd> and <Kbd>⌘V</Kbd> also work on a pane.
          </>
        ) : (
          <>
            Terminals get every plain key combination, so the app keeps to <Kbd>Ctrl</Kbd>+
            <Kbd>Shift</Kbd> and <Kbd>Alt</Kbd>.
          </>
        )}
      </p>
      <div className="help-grid">
        {SHORTCUT_GROUPS.map(([group, rows]) => (
          <section key={group}>
            <h3>{group}</h3>
            <table>
              <tbody>
                {rows.map(([keys, description]) => (
                  <tr key={keys}>
                    <td>
                      <Kbd>{isMac ? forMac(keys) : keys}</Kbd>
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
