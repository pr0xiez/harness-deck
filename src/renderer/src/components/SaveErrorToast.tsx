import { useDeck } from '../store'
import { Icon } from './Icon'

/**
 * Sits bottom-right while the deck cannot be written to disk (issue #26), and
 * comes down on its own the moment a save lands. One toast covers a whole
 * failure streak: the store only changes `saveError` when the reason does, so
 * a save failing every debounce tick does not stack or re-show anything.
 */
export function SaveErrorToast(): React.JSX.Element | null {
  const error = useDeck((s) => s.saveError)
  const dismissed = useDeck((s) => s.saveErrorDismissed)
  const retrySave = useDeck((s) => s.retrySave)
  const dismissSaveError = useDeck((s) => s.dismissSaveError)

  if (!error || dismissed) return null

  return (
    <div className="toast" role="alert">
      <div className="toast-head">
        <span className="toast-dot" />
        <strong>Couldn&rsquo;t save your workspace changes</strong>
        <button className="icon-btn tiny" title="Dismiss" onClick={dismissSaveError}>
          <Icon name="close" />
        </button>
      </div>
      <p className="toast-body bad">
        {error} &mdash; edits since the last save will be lost if the app closes.
      </p>
      <div className="toast-actions">
        <button className="btn primary" onClick={() => void retrySave()}>
          <Icon name="refresh" />
          <span>Try again</span>
        </button>
        <button className="btn ghost" onClick={dismissSaveError}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
