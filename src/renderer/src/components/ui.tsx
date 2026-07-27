import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

interface DropdownProps {
  onClose: () => void
  children: ReactNode
  className?: string
  align?: 'left' | 'right'
  /**
   * When set, the menu is portalled to <body> and positioned from this element's box,
   * so a scrolling ancestor can't clip it and it stays inside the window. Use it for
   * menus that live in narrow or overflowing containers, like the sidebar.
   */
  anchor?: RefObject<HTMLElement | null>
}

const EDGE = 8
const GAP = 6

/** Anchored popover — with no `anchor`, the parent needs `position: relative`. */
export function Dropdown({
  onClose,
  children,
  className,
  align = 'left',
  anchor
}: DropdownProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      // Ignore the anchor itself so its own click can toggle the menu shut.
      if (ref.current?.contains(target) || anchor?.current?.contains(target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, anchor])

  useLayoutEffect(() => {
    if (!anchor) return
    const place = (): void => {
      const from = anchor.current?.getBoundingClientRect()
      const menu = ref.current
      if (!from || !menu) return
      const { offsetWidth: w, offsetHeight: h } = menu

      let left = align === 'right' ? from.right - w : from.left
      left = Math.min(Math.max(left, EDGE), Math.max(EDGE, window.innerWidth - w - EDGE))

      let top = from.bottom + GAP
      if (top + h > window.innerHeight - EDGE) {
        // Not enough room below — flip above the anchor, then clamp.
        top = Math.max(EDGE, from.top - GAP - h)
      }
      setPos({ top, left })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor, align, children])

  const menu = (
    <div
      ref={ref}
      className={`dropdown ${anchor ? 'floating' : align} ${className ?? ''}`}
      role="menu"
      style={anchor ? { top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? undefined : 'hidden' } : undefined}
    >
      {children}
    </div>
  )

  return anchor ? createPortal(menu, document.body) : menu
}

interface FieldProps {
  label: string
  hint?: string
  children: ReactNode
}

export function Field({ label, hint, children }: FieldProps): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  )
}

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
}

export function Toggle({ checked, onChange, label, hint }: ToggleProps): React.JSX.Element {
  return (
    <label className="toggle-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
      <span className="toggle-text">
        <span>{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
    </label>
  )
}

export function Kbd({ children }: { children: ReactNode }): React.JSX.Element {
  return <kbd className="kbd">{children}</kbd>
}
