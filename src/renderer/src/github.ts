import { useEffect } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GitHubItem, GitHubSnapshot } from '@shared/github'

interface Mark { revision: string; acknowledged?: boolean; snoozedUntil?: number }
interface GitHubState {
  enabled: boolean
  folders: string[]
  snapshots: Record<string, GitHubSnapshot>
  marks: Record<string, Mark>
  loading: boolean
  now: number
  setEnabled: (enabled: boolean) => void
  configure: (folders: string[]) => void
  refresh: () => Promise<void>
  acknowledge: (item: GitHubItem) => void
  snooze: (item: GitHubItem) => void
  restore: (item: GitHubItem) => void
}
let generation = 0

export function needsGitHubAttention(item: GitHubItem, marks: Record<string, Mark>, now: number): boolean {
  const mark = marks[item.id]
  return !mark || mark.revision !== item.revision || (!mark.acknowledged && !(mark.snoozedUntil && mark.snoozedUntil > now))
}

export function githubItems(snapshots: Record<string, GitHubSnapshot>): GitHubItem[] {
  const items = new Map<string, GitHubItem>()
  for (const snapshot of Object.values(snapshots)) for (const item of snapshot.items) items.set(item.id, item)
  return [...items.values()]
}

export const useGitHub = create<GitHubState>()(persist((set, get) => ({
  enabled: true, folders: [], snapshots: {}, marks: {}, loading: false, now: Date.now(),
  setEnabled: (enabled) => {
    generation++
    set({ enabled, loading: false, ...(enabled ? {} : { snapshots: {} }) })
  },
  configure: (folders) => {
    generation++
    const previous = get().snapshots
    set({ folders, loading: false, snapshots: Object.fromEntries(folders.filter(f => previous[f]).map(f => [f, previous[f]])) })
  },
  refresh: async () => {
    if (!get().enabled || get().loading) return
    const current = ++generation
    set({ loading: true, now: Date.now() })
    const pending = [...get().folders]
    try {
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
        while (pending.length && generation === current) {
          const cwd = pending.shift()!
          let next: GitHubSnapshot
          try { next = await window.harness.github.query(cwd) }
          catch { next = { items: [], checkedAt: Date.now(), error: 'Could not reach GitHub. Check gh auth status and your connection.' } }
          if (generation !== current) return
          set(state => {
            const previous = state.snapshots[cwd]
            // An outage never silently clears outstanding attention.
            const snapshot = next.error && previous ? { ...previous, error: next.error } : next
            const marks = { ...state.marks }
            if (!next.error) {
              const live = new Set(next.items.map(item => item.id))
              for (const old of previous?.items ?? []) if (!live.has(old.id)) delete marks[old.id]
              for (const item of next.items) {
                const old = previous?.items.find(candidate => candidate.id === item.id)
                const mark = marks[item.id]
                if (old && mark?.revision === old.revision && item.signals.every(signal =>
                  old.signals.some(prior => prior.kind === signal.kind && prior.revision === signal.revision))) {
                  marks[item.id] = { ...mark, revision: item.revision }
                }
              }
            }
            return { snapshots: { ...state.snapshots, [cwd]: snapshot }, marks, now: Date.now() }
          })
        }
      }))
    } finally { if (generation === current) set({ loading: false }) }
  },
  acknowledge: (item) => set(state => ({ marks: { ...state.marks, [item.id]: { revision: item.revision, acknowledged: true } } })),
  snooze: (item) => set(state => ({ marks: { ...state.marks, [item.id]: { revision: item.revision, snoozedUntil: Date.now() + 3_600_000 } } })),
  restore: (item) => set(state => {
    const marks = { ...state.marks }; delete marks[item.id]; return { marks }
  })
}), {
  name: 'harness-deck-github-attention-v1',
  partialize: state => ({ enabled: state.enabled, marks: state.marks })
}))

export function githubCount(state: GitHubState, cwd?: string): number {
  if (!state.enabled) return 0
  const items = cwd !== undefined ? state.snapshots[cwd]?.items ?? [] : githubItems(state.snapshots)
  return items.filter(item => needsGitHubAttention(item, state.marks, state.now)).length
}

export function useGitHubPolling(folders: string[], hydrated: boolean): void {
  const enabled = useGitHub(s => s.enabled)
  const key = JSON.stringify([...new Set(folders.filter(Boolean))].sort())
  useEffect(() => {
    if (!hydrated) return
    useGitHub.getState().configure(JSON.parse(key))
    if (!enabled) return
    void useGitHub.getState().refresh()
    const poll = window.setInterval(() => void useGitHub.getState().refresh(), 90_000)
    const tick = window.setInterval(() => useGitHub.setState({ now: Date.now() }), 15_000)
    return () => { generation++; useGitHub.setState({ loading: false }); clearInterval(poll); clearInterval(tick) }
  }, [key, enabled, hydrated])
}
