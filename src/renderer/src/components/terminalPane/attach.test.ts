import { describe, expect, it } from 'vitest'
import { planAttach, PREVIOUS_SESSION_RULE, type AttachPlan } from './attach'

const running = (over: Partial<Parameters<typeof planAttach>[0]> = {}): Parameters<typeof planAttach>[0] => ({
  status: 'running',
  replay: '',
  ...over
})

describe('what gets painted before live output', () => {
  it('paints nothing into a fresh session', () => {
    expect(planAttach(running(), 'idle').writes).toEqual([])
  })

  it('replays buffered output on re-attach', () => {
    expect(planAttach(running({ replay: 'hello\r\n' }), 'idle').writes).toEqual(['hello\r\n'])
  })

  /**
   * The rule the constant exists for: scrollback that came off disk must be
   * marked as history before a single byte of it is painted.
   */
  it('draws the previous-session rule above restored scrollback', () => {
    expect(planAttach(running({ replay: 'old output', previousSession: true }), 'idle').writes).toEqual([
      PREVIOUS_SESSION_RULE,
      'old output'
    ])
  })

  it('still draws the rule when the restored session had no output', () => {
    expect(planAttach(running({ previousSession: true }), 'idle').writes).toEqual([PREVIOUS_SESSION_RULE])
  })
})

describe('whose status wins', () => {
  it('adopts the spawn reply for a pane that was idle', () => {
    expect(planAttach(running(), 'idle').adoptStatus).toBe(true)
  })

  /**
   * The race this module exists to lose gracefully: the process died while the
   * spawn reply was in flight, and the exit event that landed first is the
   * newer truth. Reporting "running" over it is the one wrong answer.
   */
  it('never reports a pane that already exited as running again', () => {
    expect(planAttach(running(), 'exited').adoptStatus).toBe(false)
  })

  it('adopts an exited reply even over an exited pane — same truth, fresher code', () => {
    expect(planAttach(running({ status: 'exited' }), 'exited').adoptStatus).toBe(true)
  })

  it('adopts the reply when the pane is nowhere to be found', () => {
    expect(planAttach(running(), undefined).adoptStatus).toBe(true)
  })

  it('adopts a waiting reply over a running pane', () => {
    const plan: AttachPlan = planAttach(running({ status: 'waiting' }), 'running')
    expect(plan.adoptStatus).toBe(true)
  })
})
