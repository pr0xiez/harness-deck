export const WORK_STATUSES = ['ideas', 'in_progress', 'wont_do', 'done'] as const
export type WorkStatus = typeof WORK_STATUSES[number]
export const WORK_LABELS: Record<WorkStatus, string> = {
  ideas: 'Ideas', in_progress: 'In progress', wont_do: "Won’t do", done: 'Done'
}
export interface WorkItem {
  id: string
  title: string
  description: string
  status: WorkStatus
  workspaceId: string | null
  revision: number
  createdAt: string
  updatedAt: string
}
export interface WorkBoard { version: 1; revision: number; items: WorkItem[] }
export type WorkMutation =
  | { operation: 'create'; title: string; description?: string; status?: WorkStatus; workspaceId?: string | null }
  | { operation: 'edit'; id: string; expectedRevision: number; title?: string; description?: string; workspaceId?: string | null }
  | { operation: 'move'; id: string; expectedRevision: number; status: WorkStatus }
export type WorkResult = { ok: true; board: WorkBoard; item?: WorkItem } |
  { ok: false; code: 'invalid' | 'conflict' | 'not_found' | 'storage'; error: string; current?: WorkItem }
export interface WorkAccess { enabled: boolean; command: string; wslCommand?: string; error?: string }
