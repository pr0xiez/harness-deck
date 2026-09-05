import { describe, expect, it, vi } from 'vitest'
import { createTerminalOutput } from './terminals'

describe('terminal output acknowledgements', () => {
  it('keeps live output behind replay and acknowledges only when parsed', () => {
    const write = vi.fn()
    const output = createTerminalOutput({ write })
    const ack = vi.fn()
    output.write('live', ack)
    expect(write).not.toHaveBeenCalled()
    write('replay')
    output.attach()
    expect(write.mock.calls.map(([data]) => data)).toEqual(['replay', 'live'])
    expect(ack).not.toHaveBeenCalled()
    write.mock.calls[1][1]()
    expect(ack).toHaveBeenCalledTimes(1)
    output.attach()
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('preserves separate parse callbacks for queued and attached writes', () => {
    const write = vi.fn()
    const output = createTerminalOutput({ write })
    const first = vi.fn()
    const second = vi.fn()
    output.write('first', first)
    output.attach()
    output.write('second', second)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    write.mock.calls[0][1]()
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    write.mock.calls[1][1]()
    expect(second).toHaveBeenCalledOnce()
  })
})
