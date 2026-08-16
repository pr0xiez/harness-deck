import { describe, expect, it } from 'vitest'
import { IPC } from './ipc'

describe('IPC channel table', () => {
  it('has a unique wire name per key — a duplicate would cross two channels silently', () => {
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
  })

  it('keeps every wire name in the domain:action shape the handlers key off', () => {
    for (const value of Object.values(IPC)) {
      expect(value).toMatch(/^[a-z]+:[a-zA-Z]+$/)
    }
  })
})
