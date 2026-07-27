import { describe, expect, it } from 'vitest'
import { countMatches } from './search'

describe('countMatches', () => {
  it('counts every occurrence on a line', () => {
    expect(countMatches('error error error', 'error')).toBe(3)
  })

  it('ignores case, the way the search addon does', () => {
    expect(countMatches('Error: ERROR while erroring', 'error')).toBe(3)
  })

  it('counts across lines', () => {
    expect(countMatches('npm ERR!\nnpm ERR! code 1\n', 'npm err!')).toBe(2)
  })

  it('does not count overlaps twice', () => {
    // "aaaa" holds two non-overlapping "aa", not three — findNext resumes past
    // the hit it just returned, and the count has to agree with it.
    expect(countMatches('aaaa', 'aa')).toBe(2)
  })

  it('is zero for a needle that is not there, and for no needle at all', () => {
    expect(countMatches('all quiet', 'panic')).toBe(0)
    expect(countMatches('all quiet', '')).toBe(0)
  })

  it('treats a needle with punctuation as text, not a pattern', () => {
    expect(countMatches('src/main/pty.ts and src/main/ptyXts', 'pty.ts')).toBe(1)
  })
})
