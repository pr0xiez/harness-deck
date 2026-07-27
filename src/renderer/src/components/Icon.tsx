export type IconName =
  | 'search'
  | 'maximize'
  | 'minimize'
  | 'restart'
  | 'close'
  | 'plus'
  | 'grid'
  | 'tabs'
  | 'folder'
  | 'settings'
  | 'broadcast'
  | 'trash'
  | 'help'
  | 'chevronDown'
  | 'chevronUp'
  | 'chevronLeft'
  | 'chevronRight'
  | 'command'
  | 'winMin'
  | 'winMax'
  | 'winRestore'
  | 'winClose'
  | 'check'
  | 'refresh'
  | 'mic'
  | 'stop'
  | 'pencil'

const PATHS: Record<IconName, React.JSX.Element> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </>
  ),
  maximize: <path d="M3 6V3h3M13 10v3h-3M13 6V3h-3M3 10v3h3" />,
  minimize: <path d="M6 3v3H3M10 13v-3h3M10 3v3h3M6 13v-3H3" />,
  restart: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  grid: (
    <>
      <rect x="2.5" y="2.5" width="5" height="5" rx="1" />
      <rect x="8.5" y="2.5" width="5" height="5" rx="1" />
      <rect x="2.5" y="8.5" width="5" height="5" rx="1" />
      <rect x="8.5" y="8.5" width="5" height="5" rx="1" />
    </>
  ),
  tabs: (
    <>
      <rect x="2.5" y="4.5" width="11" height="9" rx="1" />
      <path d="M2.5 7.5h11M5.5 4.5v3" />
    </>
  ),
  folder: <path d="M2.5 12.5v-8h4l1.5 2h5.5v6z" />,
  settings: (
    <>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.4" />
      <circle cx="10.5" cy="8" r="1.4" />
      <circle cx="5.5" cy="11.5" r="1.4" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="8" cy="8" r="1.6" />
      <path d="M4.6 4.6a4.8 4.8 0 0 0 0 6.8M11.4 4.6a4.8 4.8 0 0 1 0 6.8" />
      <path d="M2.4 2.4a7.9 7.9 0 0 0 0 11.2M13.6 2.4a7.9 7.9 0 0 1 0 11.2" />
    </>
  ),
  trash: (
    <>
      <path d="M3.5 5h9M6 5V3.5h4V5M5 5l.6 8h4.8L11 5" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.4 6.2a1.7 1.7 0 1 1 2.4 1.6c-.5.3-.8.7-.8 1.4M8 11.6v.1" />
    </>
  ),
  chevronDown: <path d="M4 6.5 8 10.5l4-4" />,
  chevronUp: <path d="M4 9.5 8 5.5l4 4" />,
  chevronLeft: <path d="M9.5 4 5.5 8l4 4" />,
  chevronRight: <path d="M6.5 4l4 4-4 4" />,
  command: <path d="M5.5 3.5a2 2 0 1 1 2 2v5a2 2 0 1 1-2 2 2 2 0 0 1 2-2h1a2 2 0 0 1 2 2 2 2 0 1 1-2-2v-5a2 2 0 0 1 2-2 2 2 0 1 1-2 2h-1a2 2 0 0 1-2-2z" />,
  winMin: <path d="M3 8h10" />,
  winMax: <rect x="3.5" y="3.5" width="9" height="9" rx="0.5" />,
  winRestore: (
    <>
      <rect x="5" y="5" width="7.5" height="7.5" rx="0.5" />
      <path d="M3.5 10.5v-7h7" />
    </>
  ),
  winClose: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.5 8.5 6.5 11.5 12.5 5" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
    </>
  ),
  mic: (
    <>
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
      <path d="M3.8 7.4a4.2 4.2 0 0 0 8.4 0" />
      <path d="M8 11.6v2.6M5.8 14.2h4.4" />
    </>
  ),
  stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />,
  pencil: (
    <>
      <path d="M11.2 2.6 13.4 4.8 5.6 12.6 2.8 13.2 3.4 10.4z" />
      <path d="M9.6 4.2 11.8 6.4" />
    </>
  )
}

interface Props {
  name: IconName
  size?: number
  className?: string
}

export function Icon({ name, size = 14, className }: Props): React.JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  )
}
