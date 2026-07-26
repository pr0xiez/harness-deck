import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  EnsureResult,
  PaneSpec,
  PaneStatus,
  PersistedState,
  Profile,
  PtyDataEvent,
  PtyExitEvent
} from '@shared/types'

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  loadState: (): Promise<PersistedState | null> => ipcRenderer.invoke('state:load'),
  saveState: (state: PersistedState): void => ipcRenderer.send('state:save', state),
  stateLocation: (): Promise<string> => ipcRenderer.invoke('state:location'),

  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke('profiles:list'),

  pty: {
    ensure: (spec: PaneSpec, cols: number, rows: number): Promise<EnsureResult> =>
      ipcRenderer.invoke('pty:ensure', spec, cols, rows),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    dispose: (id: string): void => ipcRenderer.send('pty:dispose', id),
    status: (id: string): Promise<{ status: PaneStatus; exitCode: number | null } | null> =>
      ipcRenderer.invoke('pty:status', id),
    running: (): Promise<string[]> => ipcRenderer.invoke('pty:running'),
    onData: (handler: (event: PtyDataEvent) => void): (() => void) =>
      subscribe('pty:data', handler),
    onExit: (handler: (event: PtyExitEvent) => void): (() => void) => subscribe('pty:exit', handler)
  },

  pickDirectory: (current?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:pickDirectory', current),
  confirm: (options: {
    title: string
    message: string
    detail?: string
    confirmLabel?: string
  }): Promise<boolean> => ipcRenderer.invoke('dialog:confirm', options),

  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    write: (text: string): void => ipcRenderer.send('clipboard:write', text)
  },

  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggleMaximize'),
    close: (): void => ipcRenderer.send('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (handler: (maximized: boolean) => void): (() => void) =>
      subscribe('window:maximized', handler),
    onFocusChange: (handler: (focused: boolean) => void): (() => void) =>
      subscribe('window:focus', handler)
  },

  openExternal: (url: string): void => ipcRenderer.send('app:openExternal', url),
  openPath: (path: string): void => ipcRenderer.send('app:openPath', path),
  capture: (target: string): Promise<string | null> => ipcRenderer.invoke('app:capture', target)
}

export type HarnessApi = typeof api

contextBridge.exposeInMainWorld('harness', api)
