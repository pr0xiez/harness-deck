import { describe, expect, it } from 'vitest'
import { parseDiff, splitLines } from './diff'

describe('patch review', () => {
  it('numbers multiple hunks and treats header-like source as changes', () => {
    const [file] = parseDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2,2 @@\n same\n---old\n+++new\n@@ -10,0 +11 @@\n+extra')
    expect(file.path).toBe('a.ts')
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(1)
    expect(file.lines.filter((l) => l.kind === 'add').map((l) => l.next)).toEqual([3, 11])
    expect(file.lines.find((l) => l.kind === 'del')).toMatchObject({ old: 3, text: '--old' })
    const rows = splitLines(file.lines)
    expect(rows.find((r) => r.left?.kind === 'del')?.right?.text).toBe('++new')
    expect(rows.at(-1)?.left).toBeUndefined()
  })
  it('keeps binary and renamed files even without hunks', () => {
    const files = parseDiff('diff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\ndiff --git a/img b/img\nBinary files a/img and b/img differ')
    expect(files.map((f) => f.path)).toEqual(['new name', 'img'])
    expect(files[1].lines[0].text).toContain('Binary files')
  })
  it('decodes quoted UTF-8 file names', () => {
    expect(parseDiff('diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"\n+++ "b/\\303\\251.ts"')[0].path).toBe('é.ts')
  })
})
