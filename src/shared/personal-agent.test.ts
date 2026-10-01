import { describe, expect, it } from 'vitest'
import { dueCheckIn, emptyPersonalData, localClock, validDue, validSettings } from './personal-agent'

describe('daily rhythm', () => {
  const data = () => { const d = emptyPersonalData('America/New_York'); d.settings.proactive = true; return d }
  it('uses the configured local day and handles daylight saving time', () => {
    expect(localClock(new Date('2026-09-30T12:30:00Z'), 'America/New_York')).toEqual({ day: '2026-09-30', minutes: 510, weekend: false })
    expect(localClock(new Date('2026-12-30T13:30:00Z'), 'America/New_York').minutes).toBe(510)
    expect(localClock(new Date('2026-10-01T00:30:00Z'), 'America/Los_Angeles').day).toBe('2026-09-30')
  })
  it('fires once per slot and limits catch-up to 90 minutes', () => {
    const d = data()
    expect(dueCheckIn(d, new Date('2026-09-30T12:29:00Z'))).toBeUndefined()
    expect(dueCheckIn(d, new Date('2026-09-30T12:30:00Z'))).toBe('morning')
    d.runs.push('2026-09-30:morning')
    expect(dueCheckIn(d, new Date('2026-09-30T12:31:00Z'))).toBeUndefined()
    expect(dueCheckIn(data(), new Date('2026-09-30T14:00:00Z'))).toBeUndefined()
    expect(dueCheckIn(d, new Date('2026-09-30T17:00:00Z'))).toBe('checkIn')
  })
  it('respects opt-in, snooze, weekdays, and does not burst when slots overlap', () => {
    const d = data(); const now = new Date('2026-09-30T12:30:00Z')
    d.settings.proactive = false; expect(dueCheckIn(d, now)).toBeUndefined()
    d.settings.proactive = true; d.settings.snoozedUntil = now.getTime() + 1
    expect(dueCheckIn(d, now)).toBeUndefined()
    d.settings.snoozedUntil = 0
    expect(dueCheckIn(d, new Date('2026-10-03T12:30:00Z'))).toBeUndefined()
    d.settings.checkIn = '08:45'; d.settings.evening = '09:00'
    expect(dueCheckIn(d, new Date('2026-09-30T13:00:00Z'))).toBe('evening')
    d.runs.push('2026-09-30:evening')
    expect(dueCheckIn(d, new Date('2026-09-30T13:01:00Z'))).toBeUndefined()
  })
  it('rejects invalid models, dates, time zones, and unordered times', () => {
    const s = data().settings
    expect(validSettings(s)).toBe(true)
    expect(validSettings({ ...s, model: 'anthropic/example-model' })).toBe(true)
    expect(validSettings({ ...s, model: 'bad\nmodel' })).toBe(false)
    expect(validSettings({ ...s, timeZone: 'No/Such_Zone' })).toBe(false)
    expect(validSettings({ ...s, checkIn: '07:00' })).toBe(false)
    expect(validDue('2026-02-30')).toBe(false)
    expect(validDue('2026-99-99')).toBe(false)
  })
})
