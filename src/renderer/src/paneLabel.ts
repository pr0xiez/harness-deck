import type { Pane, Profile } from '@shared/types'

/**
 * What a pane is called wherever one is named — headers, tabs, chips, the
 * palette and the queue. The user's own name wins, then whatever
 * the process last said about itself, then the profile the pane was opened
 * from, and the raw command is the answer of last resort so a fresh pane is
 * never unlabelled.
 */
export function paneLabel(
  pane: Pick<Pane, 'name' | 'processTitle' | 'command'>,
  profile?: Pick<Profile, 'name'>
): string {
  return pane.name || pane.processTitle || profile?.name || pane.command
}
