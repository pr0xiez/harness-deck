import { expect, it, vi } from 'vitest'
import { AGENT_MAX_STEPS, runToolLoop, type AgentRun, type AgentTransport } from './agent-loop'

const run = (): AgentRun => ({ model: 'm', key: '', system: 'coach', context: '{}', history: [{ role: 'user', text: 'x'.repeat(9000) }], prompt: 'Plan today',
  tools: [{ name: 'remember', description: 'Remember', parameters: {} }], execute: vi.fn(async () => ({ saved: true })), signal: new AbortController().signal })
const transport = (step: AgentTransport['step']): AgentTransport => ({
  message: (role, text) => ({ role, text }),
  toolResult: (call, output) => ({ role: 'tool', name: call.name, output }),
  emptyReplyError: 'empty reply', step
})

it('rejects non-object tool arguments regardless of provider', async () => {
  const r = run()
  const step = vi.fn<AgentTransport['step']>().mockResolvedValueOnce({ calls: [{ name: 'remember', args: '[1,2]' }, { name: 'remember', args: '"text"' }], assistant: { role: 'assistant' } })
    .mockResolvedValueOnce({ reply: 'Done.', calls: [] })
  expect(await runToolLoop(r, transport(step))).toBe('Done.')
  expect(r.execute).not.toHaveBeenCalled()
  const results = step.mock.calls[1][0].filter(m => (m as { role: string }).role === 'tool')
  expect(results).toHaveLength(2)
  for (const result of results) expect(result).toMatchObject({ output: expect.stringContaining('Invalid tool fields.') })
})

it('caps tool calls per step and bounds history messages', async () => {
  const r = run()
  const step = vi.fn<AgentTransport['step']>().mockResolvedValue({ calls: Array(9).fill({ name: 'remember', args: '{}' }) })
  await expect(runToolLoop(r, transport(step))).rejects.toThrow('invalid tool calls')
  expect(r.execute).not.toHaveBeenCalled()
  const history = step.mock.calls[0][0][2] as { text: string }
  expect(history.text).toHaveLength(8000)
})

it('makes the final step tool-less and never executes calls it returns', async () => {
  const r = run()
  const step = vi.fn<AgentTransport['step']>().mockResolvedValue({ calls: [{ name: 'remember', args: '{}' }], assistant: { role: 'assistant' } })
  await expect(runToolLoop(r, transport(step))).rejects.toThrow('tool limit')
  expect(step).toHaveBeenCalledTimes(AGENT_MAX_STEPS)
  expect(step.mock.calls.map(c => c[2])).toEqual([true, true, true, true, true, false])
  expect(r.execute).toHaveBeenCalledTimes(AGENT_MAX_STEPS - 1)
})
