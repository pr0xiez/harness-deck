import { expect, it, vi } from 'vitest'
import { runPersonalAI, type AgentRun } from './personal-ai'
const run = (): AgentRun => ({ model: 'provider/model', key: 'test-key', system: 'coach', context: '{}', history: [], prompt: 'Plan my day', tools: [{ name: 'remember', description: 'Remember', parameters: {} }], execute: vi.fn(async () => ({ saved: true })), signal: new AbortController().signal })
const response = (message: unknown): Response => new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 })
it('feeds tool results back to the model without running unknown tools', async () => {
  const r = run()
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ role: 'assistant', content: null, reasoning_details: [{ type: 'reasoning.encrypted', data: 'signed-block' }], tool_calls: [
    { id: '1', type: 'function', function: { name: 'remember', arguments: '{"text":"mornings"}' } },
    { id: '2', type: 'function', function: { name: 'shell', arguments: '{}' } }
  ] })).mockResolvedValueOnce(response({ role: 'assistant', content: 'Start with one task.' }))
  expect(await runPersonalAI(r, request)).toBe('Start with one task.')
  expect(r.execute).toHaveBeenCalledExactlyOnceWith('remember', { text: 'mornings' })
  const body = JSON.parse(String(request.mock.calls[1][1]!.body))
  expect(body.messages.at(-1).content).toContain('Unknown agent tool')
  expect(body.provider.data_collection).toBe('deny')
  expect(body.messages.find((m: any) => m.role === 'assistant').reasoning_details).toEqual([{ type: 'reasoning.encrypted', data: 'signed-block' }])
  expect(body.messages.some((m: any) => JSON.stringify(m).includes('test-key'))).toBe(false)
})
it('does not expose provider error bodies or credentials', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('secret-details', { status: 401 }))
  await expect(runPersonalAI(run(), request)).rejects.toThrow('rejected the API key')
})
it('stops before performing any tools when canceled', async () => {
  const r = run(); const controller = new AbortController(); r.signal = controller.signal
  const request = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return response({ role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'remember', arguments: '{}' } }] }) })
  await expect(runPersonalAI(r, request)).rejects.toThrow()
  expect(r.execute).not.toHaveBeenCalled()
})
it('caps an agent that repeatedly calls tools', async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => response({ role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'remember', arguments: '{}' } }] }))
  await expect(runPersonalAI(run(), request)).rejects.toThrow('tool limit')
  expect(request).toHaveBeenCalledTimes(6)
  expect(JSON.parse(String(request.mock.calls[5][1]!.body)).tool_choice).toBe('none')
})
