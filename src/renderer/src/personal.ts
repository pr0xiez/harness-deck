import { useEffect } from 'react'
import { create } from 'zustand'
import type { PersonalSnapshot } from '@shared/personal-agent'

/**
 * One renderer-side copy of the personal-agent snapshot, shared by the page and
 * the title-bar chip. Main owns the data and pushes every change; this only
 * follows it while at least one component is mounted, and forgets it when the
 * last one unmounts so a later mount never trusts a stale copy.
 */
interface PersonalState {
  snapshot: PersonalSnapshot | null
  /** The initial load failed. Action errors belong to the component that acted. */
  error: string
  receive: (value: PersonalSnapshot) => void
  refresh: () => Promise<void>
}

let listeners = 0
let generation = 0
let off: (() => void) | null = null

export const usePersonal = create<PersonalState>()((set, get) => ({
  snapshot: null,
  error: '',
  // Revisions only grow; an older snapshot arriving late must not undo a newer one.
  receive: (value) => {
    if (!listeners || !value?.data) return
    const current = get().snapshot
    if (current && value.data.revision < current.data.revision) return
    set({ snapshot: value, error: '' })
  },
  refresh: async () => {
    const current = generation
    try {
      const value = await window.harness.personal.snapshot()
      if (current === generation) get().receive(value)
    } catch (e) {
      if (current === generation && listeners) set({ error: String(e) })
    }
  }
}))

/**
 * Follow the personal snapshot for as long as the calling component is
 * mounted. `refresh` asks main for a fresh copy even when another component
 * already holds one — the page does, the chip does not need to.
 */
export function usePersonalFeed(refresh = false): void {
  useEffect(() => {
    if (listeners++ === 0) {
      off = window.harness.personal.onChanged((value) => usePersonal.getState().receive(value))
      void usePersonal.getState().refresh()
    } else if (refresh) void usePersonal.getState().refresh()
    return () => {
      if (--listeners) return
      off?.(); off = null; generation++
      usePersonal.setState({ snapshot: null, error: '' })
    }
  }, [refresh])
}
