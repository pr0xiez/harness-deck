import { useDeck } from '../store'
import { Icon } from './Icon'

/** Sits bottom-right whenever background work failed, until it is waved off. */
export function NoticeToast(): React.JSX.Element | null {
  const notice = useDeck((s) => s.notice)
  const setNotice = useDeck((s) => s.setNotice)
  if (!notice) return null

  return (
    <div className="toast notice" role="alert">
      <div className="toast-head">
        <span className="toast-dot" />
        <strong>{notice.title}</strong>
        <button className="icon-btn tiny" title="Dismiss" onClick={() => setNotice(null)}>
          <Icon name="close" />
        </button>
      </div>
      <p className="toast-body bad">{notice.body}</p>
    </div>
  )
}
