/** GitHub attention is read through gh; acknowledgement is local to Deck. */
export interface GitHubSignal {
  kind: 'review' | 'feedback' | 'checks'
  label: string
  url: string
  revision: string
}

export interface GitHubItem {
  id: string
  repository: string
  number: number
  title: string
  url: string
  signals: GitHubSignal[]
  /** Changes only when an actionable signal changes. */
  revision: string
}

export interface GitHubSnapshot {
  repository?: string
  account?: string
  items: GitHubItem[]
  checkedAt: number
  error?: string
  warning?: string
}
