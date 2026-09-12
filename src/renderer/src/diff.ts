export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'meta' | 'hunk'
  text: string
  old?: number
  next?: number
}
export interface DiffFile {
  path: string
  lines: DiffLine[]
  additions: number
  deletions: number
}

// Git quotes unusual paths using octal UTF-8 bytes.
function pathName(value: string): string {
  if (!value.startsWith('"')) return value.replace(/^[ab]\//, '')
  const bytes: number[] = []
  const inner = value.slice(1, value.lastIndexOf('"'))
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\') {
      const octal = inner.slice(i + 1).match(/^[0-7]{3}/)
      if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue }
      const escaped = inner[++i]
      bytes.push(({ t: 9, n: 10, r: 13 } as Record<string, number>)[escaped] ?? escaped.charCodeAt(0))
    } else bytes.push(...new TextEncoder().encode(inner[i]))
  }
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/^[ab]\//, '')
}

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let old = 0
  let next = 0
  let inHunk = false
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      const names = text.slice(11).match(/^("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/)
      file = { path: names ? pathName(names[2]) : text.slice(11), lines: [], additions: 0, deletions: 0 }
      files.push(file)
      inHunk = false
      continue
    }
    if (!file) continue
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true
      file.lines.push({ kind: 'hunk', text }); continue
    }
    if (!inHunk) {
      if (text.startsWith('+++ ') && text.slice(4) !== '/dev/null') file.path = pathName(text.slice(4).replace(/\t$/, ''))
      file.lines.push({ kind: 'meta', text }); continue
    }
    if (text.startsWith('+')) {
      file.additions++; file.lines.push({ kind: 'add', text: text.slice(1), next: next++ })
    } else if (text.startsWith('-')) {
      file.deletions++; file.lines.push({ kind: 'del', text: text.slice(1), old: old++ })
    } else if (text.startsWith(' ')) {
      file.lines.push({ kind: 'context', text: text.slice(1), old: old++, next: next++ })
    } else if (text) file.lines.push({ kind: 'meta', text })
  }
  return files
}

export function splitLines(lines: DiffLine[]): { left?: DiffLine; right?: DiffLine }[] {
  const rows: { left?: DiffLine; right?: DiffLine }[] = []
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === 'del' || lines[i].kind === 'add') {
      const left: DiffLine[] = [], right: DiffLine[] = []
      while (i < lines.length && (lines[i].kind === 'del' || lines[i].kind === 'add')) {
        const line = lines[i++]; (line.kind === 'del' ? left : right).push(line)
      }
      for (let n = 0; n < Math.max(left.length, right.length); n++) rows.push({ left: left[n], right: right[n] })
    } else { const line = lines[i++]; rows.push({ left: line, right: line }) }
  }
  return rows
}
