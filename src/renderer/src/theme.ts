import type { ITheme } from '@xterm/xterm'

/** Accent choices offered for workspaces. */
export const ACCENTS = [
  '#d97757',
  '#e5a13a',
  '#3fb950',
  '#2dd4bf',
  '#4f8ef7',
  '#7c8cf8',
  '#c084fc',
  '#f472b6'
]

export const MONO_STACK =
  '"JetBrainsMono Nerd Font", "JetBrains Mono", "Cascadia Code", "Cascadia Mono", "Fira Code", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace'

export const terminalTheme: ITheme = {
  background: '#0b0e13',
  foreground: '#d6dbe5',
  cursor: '#e6e9ef',
  cursorAccent: '#0b0e13',
  selectionBackground: 'rgba(120, 150, 220, 0.32)',
  black: '#1c2230',
  red: '#f47067',
  green: '#57ab5a',
  yellow: '#c69026',
  blue: '#539bf5',
  magenta: '#b083f0',
  cyan: '#39c5cf',
  white: '#adbac7',
  brightBlack: '#545d68',
  brightRed: '#ff938a',
  brightGreen: '#6bc46d',
  brightYellow: '#daaa3f',
  brightBlue: '#6cb6ff',
  brightMagenta: '#dcbdfb',
  brightCyan: '#56d4dd',
  brightWhite: '#cdd9e5'
}
